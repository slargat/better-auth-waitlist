import type { BetterAuthPlugin } from "@better-auth/core"
import { setCookieToHeader } from "better-auth/cookies"
import { describe, expect, it } from "vite-plus/test"
import type { WaitlistOptions } from "../index"
import { googleIdToken, signInWithGoogle, useFakeGoogle } from "./google"
import {
  admit,
  createMailbox,
  createWaitlistInstance,
  entryIdOf,
  entryOf,
  failRegisterWrites,
  PASSWORD,
  rejectEntry,
  request,
  seedUser,
  signUpAdmitted,
  usersWith,
} from "./harness"

useFakeGoogle()

const ADMITTING = { invite: { returnCodeToManager: true } } satisfies WaitlistOptions
type Instance = Awaited<ReturnType<typeof createWaitlistInstance>>

const signUp = (instance: Instance, email: string, headers: Record<string, string> = {}) =>
  request(instance, "/sign-up/email", { body: { email, password: PASSWORD, name: email }, headers })
const codeHeader = (code: string) => ({ "x-waitlist-invite": code })

async function sessionCookie(instance: Instance, email: string) {
  const headers = new Headers()
  await instance.client.signIn.email({ email, password: PASSWORD }, { onSuccess: setCookieToHeader(headers) })
  return headers.get("cookie") ?? ""
}

describe("one invite, one account", () => {
  it("refuses the old email after the registered user changes theirs, with or without the old code", async () => {
    const instance = await createWaitlistInstance(ADMITTING, {
      auth: { user: { changeEmail: { enabled: true, updateEmailWithoutVerification: true } } },
    })
    const code = await admit(instance, "ada@example.com")
    expect((await signUp(instance, "ada@example.com", codeHeader(code))).status).toBe(200)
    const cookie = await sessionCookie(instance, "ada@example.com")
    const changed = await request(instance, "/change-email", { body: { newEmail: "ada2@example.com" }, cookie })
    expect(changed.status).toBe(200)

    for (const headers of [{}, codeHeader(code), {}]) {
      expect((await signUp(instance, "ada@example.com", headers)).status).toBe(403)
    }
    expect(await usersWith(instance.db, "ada@example.com")).toEqual([])
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
  })

  it("refuses a registered email even when its user row was removed behind the plugin's back", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const user = await signUpAdmitted(instance, "ada@example.com")
    await instance.db.delete({ model: "user", where: [{ field: "id", value: user.id }] })

    const res = await signUp(instance, "ada@example.com")

    expect(res.status).toBe(403)
    expect(await usersWith(instance.db, "ada@example.com")).toEqual([])
  })

  it("frees the invite when the creation it admitted rolls back", async () => {
    let failOnce = true
    const instance = await createWaitlistInstance(ADMITTING, {
      auth: {
        databaseHooks: {
          user: {
            create: {
              before: async () => {
                if (failOnce) {
                  failOnce = false
                  throw new Error("host hook failed")
                }
              },
            },
          },
        },
      },
    })
    const code = await admit(instance, "ada@example.com")

    const failed = await signUp(instance, "ada@example.com", codeHeader(code))
    expect(failed.status).toBeGreaterThanOrEqual(400)
    expect(await (await request(instance, "/waitlist/invite/accept", { body: { code } })).json()).toMatchObject({
      valid: true,
    })

    expect((await signUp(instance, "ada@example.com", codeHeader(code))).status).toBe(200)
  })

  it("refuses to resend an invite a sign-up already claimed", async () => {
    let entryId = ""
    let resend: unknown = null
    const between: BetterAuthPlugin = {
      id: "between",
      init: () => ({
        options: {
          databaseHooks: {
            user: {
              create: {
                after: async () => {
                  resend = await instance.auth.api
                    .resendWaitlistInvite({ body: { entryId } })
                    .then(() => "resent")
                    .catch((error: { statusCode?: number }) => error.statusCode)
                },
              },
            },
          },
        },
      }),
    }
    const instance = await createWaitlistInstance(ADMITTING, { plugins: [between] })
    const code = await admit(instance, "ada@example.com")
    entryId = await entryIdOf(instance, "ada@example.com")

    expect((await signUp(instance, "ada@example.com", codeHeader(code))).status).toBe(200)

    expect(resend).toBe(409)
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
  })
})

describe("erasure on user delete", () => {
  it("deletes the deleted user's entry; the email must rejoin or be invited again", async () => {
    const instance = await createWaitlistInstance(ADMITTING, { auth: { user: { deleteUser: { enabled: true } } } })
    await signUpAdmitted(instance, "ada@example.com")
    const cookie = await sessionCookie(instance, "ada@example.com")

    const deleted = await request(instance, "/delete-user", { body: { password: PASSWORD }, cookie })

    expect(deleted.status).toBe(200)
    expect(await entryOf(instance, "ada@example.com")).toBeUndefined()
    expect((await signUp(instance, "ada@example.com")).status).toBe(403)
    const code = await admit(instance, "ada@example.com")
    expect((await signUp(instance, "ada@example.com", codeHeader(code))).status).toBe(200)
  })

  it("deletes the entry for any deletion through Better Auth (internalAdapter.deleteUser, as admin.removeUser)", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const user = await signUpAdmitted(instance, "ada@example.com")

    await (await instance.auth.$context).internalAdapter.deleteUser(user.id)

    expect(await entryOf(instance, "ada@example.com")).toBeUndefined()
  })

  it("leaves other entries alone, including one for a user without a linked entry", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const seeded = await seedUser(instance, "before@example.com")
    await instance.auth.api.joinWaitlist({ body: { email: "other@example.com" } })

    await (await instance.auth.$context).internalAdapter.deleteUser(seeded.id)

    expect(await entryOf(instance, "other@example.com")).toMatchObject({ status: "pending" })
  })
})

describe("padded emails", () => {
  it("refuses an email core would store with surrounding spaces, even with the invited email's code", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const code = await admit(instance, "ada@example.com")

    const res = await request(instance, "/sign-in/social", {
      body: { provider: "google", idToken: { token: googleIdToken({ email: " ada@example.com", sub: "padded" }) } },
      headers: codeHeader(code),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "INVALID_INVITE_CODE" })
    expect(await instance.db.findMany({ model: "user" })).toEqual([])
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "approved" })
  })
})

describe("option: join.autoApprove", () => {
  it("tells the predicate whether the email is verified: false for a typed email, true for a verified IdP claim", async () => {
    const asked: [string, boolean][] = []
    const instance = await createWaitlistInstance({
      join: {
        autoApprove: ({ email, emailVerified }) => {
          asked.push([email, emailVerified])
          return email.endsWith("@corp.test") && emailVerified
        },
      },
    })

    const typed = await signUp(instance, "ceo@corp.test")
    const google = await signInWithGoogle(instance, { email: "cto@corp.test", emailVerified: true })
    await instance.auth.api.joinWaitlist({ body: { email: "cfo@corp.test" } })

    expect(typed.status).toBe(403)
    expect(new URL(google.headers.get("location") ?? "", "http://x").pathname).toBe("/dashboard")
    expect(asked).toEqual([
      ["ceo@corp.test", false],
      ["cto@corp.test", true],
      ["cfo@corp.test", false],
    ])
  })

  it("admits an approved entry its predicate approves even with a stale or wrong code", async () => {
    const instance = await createWaitlistInstance({ ...ADMITTING, join: { autoApprove: true } })
    await admit(instance, "ada@example.com")

    const res = await signUp(instance, "ada@example.com", codeHeader("stale"))

    expect(res.status).toBe(200)
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
  })
})

describe("option: join.validate", () => {
  it("tells validate whether a blocked sign-up's email is verified", async () => {
    const asked: [string, boolean][] = []
    const background: Promise<unknown>[] = []
    const instance = await createWaitlistInstance(
      {
        gate: { joinOnBlockedSignUp: true },
        join: {
          validate: ({ email, emailVerified }) => {
            asked.push([email, emailVerified])
            return true
          },
        },
      },
      { auth: { advanced: { backgroundTasks: { handler: (task) => void background.push(task) } } } }
    )

    await signUp(instance, "typed@example.com")
    await signInWithGoogle(instance, { email: "google@example.com", emailVerified: true })
    await Promise.all(background)

    expect(asked).toEqual([
      ["typed@example.com", false],
      ["google@example.com", true],
    ])
  })
})

describe("status-read repair", () => {
  it("registers only an approved entry whose invite a sign-up claimed, never a pending or unclaimed one", async () => {
    const mailbox = createMailbox()
    const instance = await createWaitlistInstance({ ...mailbox.options, ...ADMITTING })
    for (const email of ["pending@example.com", "invited@example.com"]) {
      await instance.auth.api.joinWaitlist({ body: { email } })
      await seedUser(instance, email)
    }
    await admit(instance, "invited@example.com")

    const reads = await Promise.all(
      ["pending@example.com", "invited@example.com"].map((email) =>
        instance.auth.api.getWaitlistStatus({ query: { token: mailbox.tokenFor(email) } })
      )
    )

    expect(reads.map((read) => read.status)).toEqual(["pending", "approved"])
    expect(await entryOf(instance, "pending@example.com")).toMatchObject({ status: "pending" })
    expect(await entryOf(instance, "invited@example.com")).toMatchObject({ status: "approved" })
  })
})

describe("autoApprove timing", () => {
  it("asks the predicate exactly once per refused sign-up, whatever the entry's status", async () => {
    const calls: string[] = []
    const instance = await createWaitlistInstance(
      {
        ...ADMITTING,
        join: {
          autoApprove: ({ email }) => {
            calls.push(email)
            return false
          },
        },
      },
      { auth: { user: { changeEmail: { enabled: true, updateEmailWithoutVerification: true } } } }
    )
    await instance.auth.api.joinWaitlist({ body: { email: "pending@example.com" } })
    await instance.auth.api.joinWaitlist({ body: { email: "rejected@example.com" } })
    await rejectEntry(instance, "rejected@example.com")
    await admit(instance, "approved@example.com")
    await signUpAdmitted(instance, "registered@example.com")
    const cookie = await sessionCookie(instance, "registered@example.com")
    await request(instance, "/change-email", { body: { newEmail: "moved@example.com" }, cookie })
    const claimedCode = await admit(instance, "claimed@example.com")
    const restore = await failRegisterWrites(instance)
    await signUp(instance, "claimed@example.com", codeHeader(claimedCode))
    await restore()
    const [claimedUser] = await usersWith(instance.db, "claimed@example.com")
    await instance.db.delete({ model: "user", where: [{ field: "id", value: claimedUser?.id ?? "" }] })
    const emails = ["absent", "pending", "rejected", "approved", "registered", "claimed"].map((s) => `${s}@example.com`)
    calls.length = 0

    for (const email of emails) expect((await signUp(instance, email)).status).toBe(403)

    expect(calls).toEqual(emails)
  })
})

describe("bypass bookkeeping", () => {
  it("a bypassed creation that failed leaves nothing for a later admitted one with the same email", async () => {
    let bypassNext = true
    let failNext = true
    let requeueDuringCreation = false
    const instance: Instance = await createWaitlistInstance(
      {
        ...ADMITTING,
        gate: { allowWithoutContext: true, requireInviteCode: false, bypass: () => bypassNext },
      },
      {
        auth: {
          databaseHooks: {
            user: {
              create: {
                before: async (user) => {
                  if (failNext) {
                    failNext = false
                    throw new Error("transient host failure")
                  }
                  if (requeueDuringCreation) {
                    const entryId = await entryIdOf(instance, user.email)
                    await instance.auth.api.requeueWaitlistEntry({ body: { entryId } })
                  }
                },
              },
            },
          },
        },
      }
    )
    await admit(instance, "x@example.com")
    const context = await instance.auth.$context
    const create = () =>
      context.internalAdapter.createUser(
        { email: "x@example.com", name: "x", emailVerified: false },
        { method: "seed" }
      )

    await expect(create()).rejects.toThrow("transient host failure")
    bypassNext = false
    requeueDuringCreation = true
    await create()

    expect(await entryOf(instance, "x@example.com")).toMatchObject({ status: "pending" })
  })
})
