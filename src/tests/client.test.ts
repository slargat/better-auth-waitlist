import { readFileSync } from "node:fs"
import { createAuthClient } from "better-auth/client"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import {
  getRedirectError,
  isWaitlistError,
  WAITLIST_ERROR_CODES,
  type WaitlistClientOptions,
  waitlistClient,
} from "../client"
import type { WaitlistOptions } from "../index"
import { createMailbox, createWaitlistInstance, signInAs } from "./harness"

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string
}

type Instance = Awaited<ReturnType<typeof createWaitlistInstance>>

function recordingClient<O extends WaitlistClientOptions>(instance: Instance, options?: O) {
  const sent: string[] = []
  const client = createAuthClient({
    baseURL: "http://localhost:3000/api/auth",
    plugins: [waitlistClient(options)],
    fetchOptions: {
      customFetchImpl: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input)
        sent.push(`${init?.method ?? "GET"} ${url.pathname.replace("/api/auth", "")}`)
        return instance.customFetchImpl(input, init)
      },
    },
  })
  return { client, sent }
}

async function setup(options: WaitlistOptions = {}) {
  const mailbox = createMailbox()
  const instance = await createWaitlistInstance({
    ...mailbox.options,
    invite: { returnCodeToManager: true },
    ...options,
  })
  const { client, sent } = recordingClient(instance)
  const { headers } = await signInAs(instance, "manager@example.com")
  const asManager = { fetchOptions: { headers } }
  const idOf = async (email: string) => {
    const { entries } = await instance.auth.api.listWaitlistEntries({ query: { search: email } })
    const entry = entries.find((candidate) => candidate.email === email)
    if (!entry) throw new Error(`No entry for ${email}`)
    return entry.id
  }
  return { instance, mailbox, client, sent, asManager, idOf }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("waitlistClient: plugin shape", () => {
  it("carries the package version, the error codes and the helpers", () => {
    const plugin = waitlistClient()

    expect(plugin.id).toBe("waitlist")
    expect(plugin.version).toBe(packageJson.version)
    expect(plugin.$ERROR_CODES).toBe(WAITLIST_ERROR_CODES)
    expect(plugin.getActions()).toEqual({ waitlist: { getRedirectError, isWaitlistError } })
  })

  it("exposes the helpers on authClient.waitlist next to the inferred endpoints", async () => {
    const { client } = await setup()

    expect(client.waitlist.getRedirectError("?error=WAITLIST_INVITE_REQUIRED")).toBe("WAITLIST_INVITE_REQUIRED")
    expect(client.waitlist.isWaitlistError({ code: "WAITLIST_FULL" })).toBe(true)
    expect(client.waitlist.isWaitlistError({ code: "USER_NOT_FOUND" })).toBe(false)
  })

  it("re-exports the error codes with the server's messages (authClient.$ERROR_CODES is type-only)", () => {
    expect(WAITLIST_ERROR_CODES.WAITLIST_INVITE_REQUIRED).toMatchObject({
      code: "WAITLIST_INVITE_REQUIRED",
      message: "Waitlist invite required",
    })
    expect(WAITLIST_ERROR_CODES.INVALID_INVITE_CODE.message).toBe("Invalid or expired invite code")
  })
})

describe("waitlistClient: public actions", () => {
  it("join: POST /waitlist/join, { success: true }, and the entry exists", async () => {
    const { client, sent, mailbox } = await setup()

    const res = await client.waitlist.join({ email: "ada@example.com", name: "Ada" })

    expect(res.error).toBeNull()
    expect(res.data).toEqual({ success: true })
    expect(sent).toContain("POST /waitlist/join")
    expect(mailbox.tokenFor("ada@example.com")).toBeTypeOf("string")
  })

  it("join: sends additionalFields the client options declare, and the server stores them", async () => {
    const schema = { waitlistEntry: { additionalFields: { company: { type: "string", required: false } } } } as const
    const mailbox = createMailbox()
    const instance = await createWaitlistInstance({ ...mailbox.options, schema })
    const { client } = recordingClient(instance, { schema })

    await client.waitlist.join({ email: "ada@example.com", company: "Analytical Engines" })

    const { entries } = await instance.auth.api.listWaitlistEntries({ query: {} })
    expect(entries[0]).toMatchObject({ email: "ada@example.com", company: "Analytical Engines" })
  })

  it("join: a waitlist error comes back with its code, which isWaitlistError recognises", async () => {
    const { client } = await setup({ join: { enabled: false } })

    const res = await client.waitlist.join({ email: "ada@example.com" })

    expect(res.data).toBeNull()
    expect(res.error).toMatchObject({ status: 403, code: "WAITLIST_CLOSED", message: "Waitlist is closed" })
    expect(isWaitlistError(res.error)).toBe(true)
    expect(res.error?.message).toBe(WAITLIST_ERROR_CODES.WAITLIST_CLOSED.message)
  })

  it("status: GET /waitlist/status?token=, with the position and referralCount", async () => {
    const { client, sent, mailbox } = await setup()
    await client.waitlist.join({ email: "ada@example.com" })

    const res = await client.waitlist.status({ query: { token: mailbox.tokenFor("ada@example.com") } })

    expect(sent).toContain("GET /waitlist/status")
    expect(res.data).toMatchObject({
      email: "ada@example.com",
      status: "pending",
      position: 1,
      queueLength: 1,
      referralCount: 0,
      emailConfirmed: false,
      invite: null,
    })
    expect(res.data?.referralCode).toMatch(/^[A-Za-z0-9]+$/)
  })

  it("status: a forged token is INVALID_STATUS_TOKEN", async () => {
    const { client } = await setup()

    const res = await client.waitlist.status({ query: { token: "nope.nope" } })

    expect(res.error).toMatchObject({ status: 400, code: "INVALID_STATUS_TOKEN" })
  })

  it("confirm: POST /waitlist/confirm, then status shows the email confirmed", async () => {
    const { client, sent, mailbox } = await setup()
    await client.waitlist.join({ email: "ada@example.com" })
    const token = mailbox.tokenFor("ada@example.com")

    const res = await client.waitlist.confirm({ token })

    expect(sent).toContain("POST /waitlist/confirm")
    expect(res.data).toEqual({ success: true })
    expect((await client.waitlist.status({ query: { token } })).data?.emailConfirmed).toBe(true)
  })

  it("referralCount: a confirmed referral counts on the referrer's status (the onReferralSuccess payload's count)", async () => {
    const referrals: number[] = []
    const { client, mailbox } = await setup({
      onReferralSuccess: ({ referralCount }) => void referrals.push(referralCount),
    })
    await client.waitlist.join({ email: "ada@example.com" })
    const adaToken = mailbox.tokenFor("ada@example.com")
    const referralCode = (await client.waitlist.status({ query: { token: adaToken } })).data?.referralCode
    await client.waitlist.join({ email: "bob@example.com", referralCode })

    await client.waitlist.confirm({ token: mailbox.tokenFor("bob@example.com") })

    expect(referrals).toEqual([1])
    expect((await client.waitlist.status({ query: { token: adaToken } })).data?.referralCount).toBe(1)
  })

  it("invite.accept: POST /waitlist/invite/accept, the email for a valid code, { valid: false } otherwise", async () => {
    const { client, sent, instance } = await setup()
    const { code } = await instance.auth.api.inviteToWaitlist({ body: { email: "ada@example.com" } })
    if (!code) throw new Error("returnCodeToManager is on, so the invite carries its code")
    const setCookies: string[] = []

    const valid = await client.waitlist.invite.accept(
      { code },
      { onResponse: ({ response }) => void setCookies.push(response.headers.get("set-cookie") ?? "") }
    )
    const invalid = await client.waitlist.invite.accept({ code: "wrong" })

    expect(sent).toContain("POST /waitlist/invite/accept")
    expect(valid.data).toMatchObject({ valid: true, email: "ada@example.com" })
    expect(setCookies).toEqual([expect.stringMatching(/waitlist_invite=/)])
    expect(invalid.data).toEqual({ valid: false })
  })
})

describe("waitlistClient: manager actions", () => {
  it("admin.list and admin.stats: GET, with the server's query", async () => {
    const { client, sent, asManager } = await setup()
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    await client.waitlist.join({ email: "ada@example.com" })
    vi.advanceTimersByTime(1000)
    await client.waitlist.join({ email: "bob@example.com" })

    const list = await client.waitlist.admin.list({ query: { status: "pending", sortBy: "queue" }, ...asManager })
    const stats = await client.waitlist.admin.stats(asManager)

    expect(sent).toEqual(expect.arrayContaining(["GET /waitlist/admin/list", "GET /waitlist/admin/stats"]))
    expect(list.data?.total).toBe(2)
    expect(list.data?.entries.map((entry) => [entry.email, "position" in entry && entry.position])).toEqual([
      ["ada@example.com", 1],
      ["bob@example.com", 2],
    ])
    expect(stats.data).toMatchObject({ pending: 2, approved: 0, total: 2 })
  })

  it("admin.approve: POST, by entryIds and by next, with the codes", async () => {
    const { client, sent, asManager, idOf } = await setup()
    await client.waitlist.join({ email: "ada@example.com" })
    await client.waitlist.join({ email: "bob@example.com" })
    const adaId = await idOf("ada@example.com")

    const byIds = await client.waitlist.admin.approve({ entryIds: [adaId], ...asManager })
    const next = await client.waitlist.admin.approve({ next: 1, confirmedOnly: false, ...asManager })

    expect(sent.filter((line) => line === "POST /waitlist/admin/approve")).toHaveLength(2)
    expect(byIds.data?.results).toEqual([{ entryId: adaId, outcome: "approved", code: expect.any(String) }])
    expect(next.data?.results).toEqual([
      { entryId: await idOf("bob@example.com"), outcome: "approved", code: expect.any(String) },
    ])
  })

  it("admin.reject and admin.requeue: POST, rejected then back to pending", async () => {
    const { client, sent, asManager, idOf } = await setup()
    await client.waitlist.join({ email: "ada@example.com" })
    const entryId = await idOf("ada@example.com")

    const rejected = await client.waitlist.admin.reject({ entryIds: [entryId], reason: "spam", ...asManager })
    const requeued = await client.waitlist.admin.requeue({ entryId, ...asManager })

    expect(sent).toEqual(expect.arrayContaining(["POST /waitlist/admin/reject", "POST /waitlist/admin/requeue"]))
    expect(rejected.data?.results).toEqual([{ entryId, outcome: "rejected" }])
    expect(requeued.data?.entry).toMatchObject({ id: entryId, status: "pending" })
  })

  it("admin.invite and admin.resendInvite: POST, each with a new code", async () => {
    const { client, sent, asManager } = await setup()

    const invited = await client.waitlist.admin.invite({ email: "ada@example.com", name: "Ada", ...asManager })
    const entryId = invited.data?.entry.id ?? ""
    const resent = await client.waitlist.admin.resendInvite({ entryId, ...asManager })

    expect(sent).toEqual(expect.arrayContaining(["POST /waitlist/admin/invite", "POST /waitlist/admin/resend-invite"]))
    expect(invited.data?.entry).toMatchObject({ email: "ada@example.com", status: "approved" })
    expect(resent.data?.entry).toMatchObject({ id: entryId, status: "approved" })
    expect(invited.data?.code).toEqual(expect.any(String))
    expect(resent.data?.code).toEqual(expect.any(String))
    expect(resent.data?.code).not.toBe(invited.data?.code)
  })

  it("admin.boost: POST, moves the entry ahead", async () => {
    const { client, sent, asManager, idOf, mailbox } = await setup()
    await client.waitlist.join({ email: "ada@example.com" })
    await client.waitlist.join({ email: "bob@example.com" })
    const bobId = await idOf("bob@example.com")

    const boosted = await client.waitlist.admin.boost({ entryId: bobId, seconds: 3600, ...asManager })

    expect(sent).toContain("POST /waitlist/admin/boost")
    expect(boosted.data?.entry).toMatchObject({ id: bobId, boostSeconds: 3600 })
    const status = await client.waitlist.status({ query: { token: mailbox.tokenFor("bob@example.com") } })
    expect(status.data?.position).toBe(1)
  })

  it("admin.delete: POST, and the entry is gone", async () => {
    const { client, sent, asManager, idOf, instance } = await setup()
    await client.waitlist.join({ email: "ada@example.com" })
    const entryId = await idOf("ada@example.com")

    const res = await client.waitlist.admin.delete({ entryId, ...asManager })

    expect(sent).toContain("POST /waitlist/admin/delete")
    expect(res.data).toEqual({ success: true })
    expect((await instance.auth.api.listWaitlistEntries({ query: {} })).total).toBe(0)
  })

  it("a missing entry is ENTRY_NOT_FOUND, a non-manager NOT_ALLOWED_TO_MANAGE_WAITLIST, and no session 401", async () => {
    const { client, asManager, instance } = await setup()
    const { headers: userHeaders } = await signInAs(instance, "user@example.com", "user")

    const missing = await client.waitlist.admin.requeue({ entryId: "missing", ...asManager })
    const notManager = await client.waitlist.admin.stats({ fetchOptions: { headers: userHeaders } })
    const anonymous = await client.waitlist.admin.stats()

    expect(missing.error).toMatchObject({ status: 404, code: "ENTRY_NOT_FOUND" })
    expect(notManager.error).toMatchObject({ status: 403, code: "NOT_ALLOWED_TO_MANAGE_WAITLIST" })
    expect(isWaitlistError(notManager.error)).toBe(true)
    expect(anonymous.error?.status).toBe(401)
    expect(isWaitlistError(anonymous.error)).toBe(false)
  })
})
