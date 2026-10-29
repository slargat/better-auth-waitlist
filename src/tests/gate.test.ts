import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { type OnStatusChangeData, WAITLIST_ERROR_CODES, type WaitlistOptions, waitlist } from "../index"
import {
  admit,
  cookiesFrom,
  createInviteMailbox,
  createWaitlistInstance,
  entryIdOf,
  entryOf,
  PASSWORD,
  rejectEntry,
  request,
  signUpAdmitted,
  usersWith,
} from "./harness"
import { createLogger } from "./logger"

afterEach(() => {
  vi.useRealTimers()
})

const ADMITTING = { invite: { returnCodeToManager: true } } satisfies WaitlistOptions
type Instance = Awaited<ReturnType<typeof createWaitlistInstance>>
const SEED = { method: "seed-script" }

const signUp = (instance: Instance, email: string, init: { cookie?: string; headers?: Record<string, string> } = {}) =>
  request(instance, "/sign-up/email", { body: { email, password: PASSWORD, name: email }, ...init })

const accept = (instance: Instance, code: string, cookie?: string) =>
  request(instance, "/waitlist/invite/accept", { body: { code }, cookie })

const codeHeader = (code: string) => ({ "x-waitlist-invite": code })

async function refusalOf(res: Response) {
  return { status: res.status, body: await res.json() }
}

describe("gate: email sign-up", () => {
  it("refuses an email that isn't admitted with 403 WAITLIST_INVITE_REQUIRED, and creates no user", async () => {
    const instance = await createWaitlistInstance(ADMITTING)

    const res = await signUp(instance, "ada@example.com")

    expect(await refusalOf(res)).toEqual({
      status: 403,
      body: { code: "WAITLIST_INVITE_REQUIRED", message: WAITLIST_ERROR_CODES.WAITLIST_INVITE_REQUIRED.message },
    })
    expect(await usersWith(instance.db, "ada@example.com")).toEqual([])
  })

  it("refuses with INVALID_INVITE_CODE when a code is presented and doesn't match", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    await admit(instance, "ada@example.com")

    const res = await signUp(instance, "ada@example.com", { headers: codeHeader("not-the-code") })

    expect((await refusalOf(res)).body).toMatchObject({ code: "INVALID_INVITE_CODE" })
    expect(await usersWith(instance.db, "ada@example.com")).toEqual([])
  })

  it("admits the invited email with its code, creates the user and registers the entry", async () => {
    const changes: OnStatusChangeData[] = []
    const instance = await createWaitlistInstance({ ...ADMITTING, onStatusChange: (data) => void changes.push(data) })
    const code = await admit(instance, "ada@example.com")
    changes.length = 0

    const res = await signUp(instance, "ada@example.com", { headers: codeHeader(code) })

    expect(res.status).toBe(200)
    const [user] = await usersWith(instance.db, "ada@example.com")
    expect(user).toBeDefined()
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({
      status: "registered",
      userId: user?.id,
      registeredAt: expect.any(Date),
      inviteExpiresAt: null,
    })
    expect(changes.map((change) => [change.event, change.from, change.to, change.actorUserId])).toEqual([
      ["register", "approved", "registered", null],
    ])
  })

  it("answers the same for a pending, rejected, unknown, or approved email without its code", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    await instance.auth.api.joinWaitlist({ body: { email: "pending@example.com" } })
    await instance.auth.api.joinWaitlist({ body: { email: "rejected@example.com" } })
    await rejectEntry(instance, "rejected@example.com")
    await admit(instance, "approved@example.com")

    const emails = ["pending@example.com", "rejected@example.com", "unknown@example.com", "approved@example.com"]
    const without = await Promise.all(emails.map(async (email) => refusalOf(await signUp(instance, email))))
    const wrongCode = await Promise.all(
      emails.map(async (email) => refusalOf(await signUp(instance, email, { headers: codeHeader("guess") })))
    )

    expect(new Set(without.map((res) => JSON.stringify(res))).size).toBe(1)
    expect(without[0]).toMatchObject({ status: 403, body: { code: "WAITLIST_INVITE_REQUIRED" } })
    expect(new Set(wrongCode.map((res) => JSON.stringify(res))).size).toBe(1)
    expect(wrongCode[0]).toMatchObject({ status: 403, body: { code: "INVALID_INVITE_CODE" } })
    for (const email of emails) expect(await usersWith(instance.db, email)).toEqual([])
  })
})

describe("Better Auth 1.7 sign-up masking (pinned)", () => {
  it.each([
    ["requireEmailVerification", { emailAndPassword: { enabled: true, requireEmailVerification: true } }],
    ["autoSignIn: false", { emailAndPassword: { enabled: true, autoSignIn: false } }],
  ] as const)("with %s, a blocked sign-up looks like a success, with no user row and no email", async (_, auth) => {
    const sendVerificationEmail = vi.fn(async () => {})
    const instance = await createWaitlistInstance(ADMITTING, {
      auth: { ...auth, emailVerification: { sendVerificationEmail, sendOnSignUp: true } },
    })
    await instance.auth.api.joinWaitlist({ body: { email: "pending@example.com" } })

    const blocked = await signUp(instance, "pending@example.com")
    const unknown = await signUp(instance, "unknown@example.com")

    for (const res of [blocked, unknown]) {
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ token: null, user: { emailVerified: false } })
    }
    expect(await usersWith(instance.db, "pending@example.com")).toEqual([])
    expect(await usersWith(instance.db, "unknown@example.com")).toEqual([])
    expect(sendVerificationEmail).not.toHaveBeenCalled()
  })

  it("leaves an admitted sign-up unmasked: the user is created and verification is sent", async () => {
    const sendVerificationEmail = vi.fn(async () => {})
    const instance = await createWaitlistInstance(ADMITTING, {
      auth: {
        emailAndPassword: { enabled: true, requireEmailVerification: true },
        emailVerification: { sendVerificationEmail },
      },
    })
    const code = await admit(instance, "ada@example.com")

    const res = await signUp(instance, "ada@example.com", { headers: codeHeader(code) })

    expect(res.status).toBe(200)
    expect(await usersWith(instance.db, "ada@example.com")).toHaveLength(1)
    expect(sendVerificationEmail).toHaveBeenCalledOnce()
  })
})

describe("gate: codes and admission", () => {
  it("a code works once: a second account can't reuse it", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const code = await admit(instance, "ada@example.com")
    expect((await signUp(instance, "ada@example.com", { headers: codeHeader(code) })).status).toBe(200)

    const reuse = await signUp(instance, "bob@example.com", { headers: codeHeader(code) })

    expect((await refusalOf(reuse)).body).toMatchObject({ code: "INVALID_INVITE_CODE" })
    expect(await usersWith(instance.db, "bob@example.com")).toEqual([])
    expect(await (await accept(instance, code)).json()).toEqual({ valid: false })
  })

  it("refuses a code issued for another email, and leaves both entries alone", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const forAda = await admit(instance, "ada@example.com")
    await admit(instance, "bob@example.com")
    const before = await entryOf(instance, "bob@example.com")

    const res = await signUp(instance, "bob@example.com", { headers: codeHeader(forAda) })

    expect((await refusalOf(res)).body).toMatchObject({ code: "INVALID_INVITE_CODE" })
    expect(await entryOf(instance, "bob@example.com")).toEqual(before)
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "approved" })
  })

  it("refuses an expired code", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    const instance = await createWaitlistInstance({ invite: { returnCodeToManager: true, expiresIn: 60 } })
    const code = await admit(instance, "ada@example.com")

    vi.advanceTimersByTime(61_000)
    const res = await signUp(instance, "ada@example.com", { headers: codeHeader(code) })

    expect((await refusalOf(res)).body).toMatchObject({ code: "INVALID_INVITE_CODE" })
    expect(await usersWith(instance.db, "ada@example.com")).toEqual([])
  })

  it("refuses the old code after a resend, and admits the new one", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const old = await admit(instance, "ada@example.com")
    const resent = await instance.auth.api.resendWaitlistInvite({
      body: { entryId: await entryIdOf(instance, "ada@example.com") },
    })

    const stale = await signUp(instance, "ada@example.com", { headers: codeHeader(old) })
    const fresh = await signUp(instance, "ada@example.com", { headers: codeHeader(resent.code ?? "") })

    expect((await refusalOf(stale)).body).toMatchObject({ code: "INVALID_INVITE_CODE" })
    expect(fresh.status).toBe(200)
  })

  it("reads the code from the invite cookie /waitlist/invite/accept sets, and clears it once registered", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const code = await admit(instance, "ada@example.com")
    const cookie = cookiesFrom(await accept(instance, code))
    expect(cookie).toContain("better-auth.waitlist_invite=")

    const res = await signUp(instance, "ada@example.com", { cookie })

    expect(res.status).toBe(200)
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
    expect(res.headers.get("set-cookie")).toMatch(/better-auth\.waitlist_invite=; Max-Age=0/)
  })

  it("takes the header before the cookie", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const code = await admit(instance, "ada@example.com")
    const cookie = cookiesFrom(await accept(instance, code))

    const res = await signUp(instance, "ada@example.com", { cookie, headers: codeHeader("wrong") })

    expect((await refusalOf(res)).body).toMatchObject({ code: "INVALID_INVITE_CODE" })
  })

  it("treats a cookie that fails its signature as a presented, wrong code", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const code = await admit(instance, "ada@example.com")

    const res = await signUp(instance, "ada@example.com", { cookie: `better-auth.waitlist_invite=${code}.forged` })

    expect((await refusalOf(res)).body).toMatchObject({ code: "INVALID_INVITE_CODE" })
    expect(await usersWith(instance.db, "ada@example.com")).toEqual([])
  })

  it("registers through the default email sign-up client with the header", async () => {
    const instance = await createWaitlistInstance(ADMITTING)

    const user = await signUpAdmitted(instance, "ada@example.com")

    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered", userId: user.id })
  })
})

describe("option: gate.requireInviteCode", () => {
  it("is on by default: approval alone doesn't admit", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    await admit(instance, "ada@example.com")

    expect((await signUp(instance, "ada@example.com")).status).toBe(403)
  })

  it("false admits an approved email with a live invite and no code, and nothing else", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    const instance = await createWaitlistInstance({
      gate: { requireInviteCode: false },
      invite: { returnCodeToManager: true, expiresIn: 60 },
    })
    await admit(instance, "ada@example.com")
    await admit(instance, "late@example.com")
    await instance.auth.api.joinWaitlist({ body: { email: "pending@example.com" } })

    expect((await signUp(instance, "ada@example.com")).status).toBe(200)
    expect((await signUp(instance, "pending@example.com")).status).toBe(403)
    vi.advanceTimersByTime(61_000)
    expect((await signUp(instance, "late@example.com")).status).toBe(403)
  })
})

describe("option: join.autoApprove", () => {
  it("admits an email it approves without a code, creating the approved entry and registering it", async () => {
    const joins: unknown[] = []
    const instance = await createWaitlistInstance({
      join: { autoApprove: ({ email }) => email.endsWith("@vip.test") },
      onJoin: (data) => void joins.push([data.entry.email, data.source]),
    })

    const vip = await signUp(instance, "ada@vip.test")
    const other = await signUp(instance, "bob@example.com")

    expect(vip.status).toBe(200)
    expect(await entryOf(instance, "ada@vip.test")).toMatchObject({ status: "registered" })
    expect(joins).toEqual([["ada@vip.test", "sign-up"]])
    expect(other.status).toBe(403)
    expect(await entryOf(instance, "bob@example.com")).toBeUndefined()
  })

  it("admits an auto-approved join's entry at sign-up without its code", async () => {
    const instance = await createWaitlistInstance({ join: { autoApprove: true } })
    await instance.auth.api.joinWaitlist({ body: { email: "ada@example.com" } })

    const res = await signUp(instance, "ada@example.com")

    expect(res.status).toBe(200)
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
  })

  it("counts a predicate that throws as false: refused, logged, and the response unchanged", async () => {
    const { lines, logger } = createLogger()
    const instance = await createWaitlistInstance(
      {
        join: {
          autoApprove: () => {
            throw new Error("predicate down")
          },
        },
      },
      { auth: { logger } }
    )

    const res = await signUp(instance, "ada@example.com")

    expect((await refusalOf(res)).body).toMatchObject({ code: "WAITLIST_INVITE_REQUIRED" })
    expect(lines.some((line) => line.level === "error" && line.message.includes("join.autoApprove threw"))).toBe(true)
  })
})

describe("option: gate.enabled", () => {
  it("false lets anyone sign up", async () => {
    const instance = await createWaitlistInstance({ gate: { enabled: false } })

    expect((await signUp(instance, "ada@example.com")).status).toBe(200)
    expect(await usersWith(instance.db, "ada@example.com")).toHaveLength(1)
  })

  it("false still registers an entry whose email signs up", async () => {
    const instance = await createWaitlistInstance({ gate: { enabled: false } })
    await instance.auth.api.joinWaitlist({ body: { email: "ada@example.com" } })

    await signUp(instance, "ada@example.com")

    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
  })
})

describe("POST /waitlist/invite/accept", () => {
  it("returns the invited email and expiry for a valid code, and sets the signed invite cookie", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    const instance = await createWaitlistInstance(ADMITTING)
    const code = await admit(instance, "ada@example.com")

    const res = await accept(instance, code)

    expect(await res.json()).toEqual({ valid: true, email: "ada@example.com", expiresAt: "2026-01-08T00:00:00.000Z" })
    const setCookie = res.headers.get("set-cookie") ?? ""
    expect(setCookie).toMatch(/^better-auth\.waitlist_invite=[^;]+\.[^;]+;/)
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("SameSite=Lax")
    expect(setCookie).toContain("Path=/")
  })

  it("returns the typed result through auth.api, with a null expiry for an invite that never expires", async () => {
    const instance = await createWaitlistInstance({ invite: { returnCodeToManager: true, expiresIn: null } })
    const code = await admit(instance, "ada@example.com")

    expect(await instance.auth.api.acceptWaitlistInvite({ body: { code } })).toEqual({
      valid: true,
      email: "ada@example.com",
      expiresAt: null,
    })
  })

  it("answers { valid: false } with no email and no cookie for an unknown, expired, used, rejected or requeued code", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    const instance = await createWaitlistInstance({ invite: { returnCodeToManager: true, expiresIn: 60 } })
    const expired = await admit(instance, "expired@example.com")
    const used = await admit(instance, "used@example.com")
    await signUp(instance, "used@example.com", { headers: codeHeader(used) })
    const rejected = await admit(instance, "rejected@example.com")
    await rejectEntry(instance, "rejected@example.com")
    const requeued = await admit(instance, "requeued@example.com")
    await instance.auth.api.requeueWaitlistEntry({
      body: { entryId: await entryIdOf(instance, "requeued@example.com") },
    })
    vi.advanceTimersByTime(61_000)

    for (const code of ["unknown-code", expired, used, rejected, requeued]) {
      const res = await accept(instance, code)
      expect(await res.json()).toEqual({ valid: false })
      expect(res.headers.get("set-cookie")).toBeNull()
    }
  })

  it("names the cookie with the host's cookie prefix", async () => {
    const instance = await createWaitlistInstance(ADMITTING, { auth: { advanced: { cookiePrefix: "app" } } })
    const code = await admit(instance, "ada@example.com")

    const cookie = cookiesFrom(await accept(instance, code))

    expect(cookie).toMatch(/^app\.waitlist_invite=/)
    expect((await signUp(instance, "ada@example.com", { cookie })).status).toBe(200)
  })
})

describe("option: invite.cookieMaxAge", () => {
  it("is 1800 seconds by default", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const res = await accept(instance, await admit(instance, "ada@example.com"))

    expect(res.headers.get("set-cookie")).toContain("Max-Age=1800")
  })

  it("sets the cookie's lifetime", async () => {
    const instance = await createWaitlistInstance({ invite: { returnCodeToManager: true, cookieMaxAge: 120 } })
    const res = await accept(instance, await admit(instance, "ada@example.com"))

    expect(res.headers.get("set-cookie")).toContain("Max-Age=120")
  })
})

describe("option: invite.header", () => {
  it("renames the header the code is read from", async () => {
    const instance = await createWaitlistInstance({ invite: { returnCodeToManager: true, header: "x-invite" } })
    const code = await admit(instance, "ada@example.com")

    expect((await signUp(instance, "ada@example.com", { headers: codeHeader(code) })).status).toBe(403)
    expect((await signUp(instance, "ada@example.com", { headers: { "x-invite": code } })).status).toBe(200)
  })
})

describe("option: gate.bypass", () => {
  it("lets admin.createUser through by default", async () => {
    const instance = await createWaitlistInstance(ADMITTING)

    const { user } = await instance.auth.api.createUser({ body: { email: "staff@example.com", name: "Staff" } })

    expect(user.email).toBe("staff@example.com")
  })

  it("registers a pending or rejected entry whose email a bypass let in (the bypass path)", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    await instance.auth.api.joinWaitlist({ body: { email: "pending@example.com" } })
    await instance.auth.api.joinWaitlist({ body: { email: "rejected@example.com" } })
    await rejectEntry(instance, "rejected@example.com")

    for (const email of ["pending@example.com", "rejected@example.com"]) {
      await instance.auth.api.createUser({ body: { email, name: email } })
      expect(await entryOf(instance, email)).toMatchObject({ status: "registered" })
    }
  })

  it("replaces the default, receiving the user and the endpoint context", async () => {
    const seen: [string | undefined, string | undefined][] = []
    const instance = await createWaitlistInstance({
      gate: {
        bypass: ({ user, ctx }) => {
          seen.push([user.email, ctx?.path])
          return user.email?.endsWith("@staff.test") ?? false
        },
      },
    })

    const staff = await signUp(instance, "ada@staff.test")
    const other = await signUp(instance, "bob@example.com")
    const created = instance.auth.api.createUser({ body: { email: "c@example.com", name: "C" } })

    expect(staff.status).toBe(200)
    expect(other.status).toBe(403)
    await expect(created).rejects.toMatchObject({ statusCode: 403 })
    expect(seen).toEqual([
      ["ada@staff.test", "/sign-up/email"],
      ["bob@example.com", "/sign-up/email"],
      ["c@example.com", "/admin/create-user"],
    ])
  })

  it("counts a bypass that throws as false, and logs it with the presented code redacted", async () => {
    const { lines, logger } = createLogger()
    const instance = await createWaitlistInstance(
      {
        ...ADMITTING,
        gate: {
          bypass: ({ ctx }) => {
            throw new Error(`bypass down for ${ctx?.headers?.get("x-waitlist-invite")}`)
          },
        },
      },
      { auth: { logger } }
    )
    const code = await admit(instance, "ada@example.com")

    const wrong = await signUp(instance, "bob@example.com", { headers: codeHeader(code) })
    const right = await signUp(instance, "ada@example.com", { headers: codeHeader(code) })

    expect((await refusalOf(wrong)).body).toMatchObject({ code: "INVALID_INVITE_CODE" })
    expect(right.status).toBe(200)
    const errors = lines.filter((line) => line.level === "error").map((line) => line.message)
    expect(errors.filter((message) => message.includes("gate.bypass threw"))).toHaveLength(2)
    expect(errors.join("\n")).not.toContain(code)
    expect(errors.join("\n")).toContain("[redacted]")
  })
})

describe("option: gate.allowWithoutContext", () => {
  it("is off by default: a creation with no endpoint context is refused, even for an admitted email", async () => {
    const instance = await createWaitlistInstance({ gate: { requireInviteCode: false }, ...ADMITTING })
    await admit(instance, "ada@example.com")
    const context = await instance.auth.$context

    const created = context.internalAdapter.createUser(
      { email: "ada@example.com", name: "Ada", emailVerified: false },
      SEED
    )

    await expect(created).rejects.toMatchObject({ statusCode: 403, body: { code: "WAITLIST_INVITE_REQUIRED" } })
    expect(await usersWith(instance.db, "ada@example.com")).toEqual([])
  })

  it("true sends a context-less creation on to bypass (ctx null) and admission", async () => {
    const registers: [string, boolean][] = []
    const instance = await createWaitlistInstance({
      ...ADMITTING,
      gate: {
        allowWithoutContext: true,
        requireInviteCode: false,
        bypass: ({ ctx, user }) => ctx === null && user.name === "seed",
      },
      onStatusChange: (data, ctx) => {
        if (data.event === "register") registers.push([data.entry.email, ctx === null])
      },
    })
    await admit(instance, "approved@example.com")
    const context = await instance.auth.$context
    const create = (email: string, name: string) =>
      context.internalAdapter.createUser({ email, name, emailVerified: false }, SEED)

    await expect(create("seeded@example.com", "seed")).resolves.toMatchObject({ email: "seeded@example.com" })
    await expect(create("approved@example.com", "Ada")).resolves.toMatchObject({ email: "approved@example.com" })
    await expect(create("other@example.com", "Bob")).rejects.toMatchObject({ statusCode: 403 })
    expect(await entryOf(instance, "approved@example.com")).toMatchObject({ status: "registered" })
    expect(registers).toEqual([["approved@example.com", true]])
  })

  it("still refuses a user without an email", async () => {
    const instance = await createWaitlistInstance({ gate: { allowWithoutContext: true } })
    const context = await instance.auth.$context

    const created = context.internalAdapter.createUser({ email: "", name: "No email", emailVerified: false }, SEED)

    await expect(created).rejects.toMatchObject({ statusCode: 403, body: { code: "WAITLIST_INVITE_REQUIRED" } })
  })
})

describe("register after create", () => {
  it("is repaired by the next status read when the transition fails after the user exists", async () => {
    const { DatabaseSync } = await import("node:sqlite")
    const database = new DatabaseSync(":memory:")
    const { lines, logger } = createLogger()
    const invites = createInviteMailbox()
    const statusLinks: string[] = []
    const instance = await createWaitlistInstance(
      {
        ...invites.options,
        statusLink: { buildUrl: (token) => token },
        sendStatusLink: async ({ token }) => void statusLinks.push(token),
      },
      { auth: { database, logger } }
    )
    await instance.auth.api.joinWaitlist({ body: { email: "ada@example.com" } })
    await instance.auth.api.approveWaitlistEntries({
      body: { entryIds: [await entryIdOf(instance, "ada@example.com")] },
    })
    const code = invites.codeFor("ada@example.com")
    database.exec(
      `CREATE TRIGGER fail_register BEFORE UPDATE ON waitlistEntry WHEN NEW.status = 'registered'
       BEGIN SELECT RAISE(ABORT, 'register write failed'); END`
    )

    const res = await signUp(instance, "ada@example.com", { headers: codeHeader(code) })

    expect(res.status).toBe(200)
    expect(await usersWith(instance.db, "ada@example.com")).toHaveLength(1)
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "approved" })
    const errors = lines.filter((line) => line.level === "error").map((line) => line.message)
    expect(errors.some((message) => message.includes("register after sign-up failed"))).toBe(true)
    expect(errors.join("\n")).not.toContain(code)

    database.exec("DROP TRIGGER fail_register")
    const status = await instance.auth.api.getWaitlistStatus({ query: { token: statusLinks[0] ?? "" } })

    expect(status).toMatchObject({ status: "registered", invite: null })
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
  })
})

describe("gate shape", () => {
  it("is databaseHooks on user create (the gate), delete (erasure) and account create (reset guard), plus the Guest claim and reset request hooks; no session hooks", async () => {
    const instance = await createWaitlistInstance({})
    const plugin = waitlist({})

    // oxlint-disable-next-line typescript/unbound-method -- applied with the plugin as `this`
    const result: unknown = await Reflect.apply(plugin.init, plugin, [await instance.auth.$context])

    expect(plugin.hooks).toEqual({
      before: [
        { matcher: expect.any(Function), handler: expect.any(Function) },
        { matcher: expect.any(Function), handler: expect.any(Function) },
      ],
    })
    const [claim, reset] = plugin.hooks.before
    const paths = ["/sign-up/email", "/request-password-reset", "/sign-in/email", "/get-session"]
    expect(paths.map((path) => claim?.matcher({ path } as Parameters<typeof claim.matcher>[0]))).toEqual([
      true,
      false,
      false,
      false,
    ])
    expect(paths.map((path) => reset?.matcher({ path } as Parameters<typeof reset.matcher>[0]))).toEqual([
      false,
      true,
      false,
      false,
    ])
    expect(result).toEqual({
      options: {
        databaseHooks: {
          user: {
            create: { before: expect.any(Function), after: expect.any(Function) },
            delete: { before: expect.any(Function) },
          },
          account: { create: { before: expect.any(Function), after: expect.any(Function) } },
        },
      },
    })
  })
})
