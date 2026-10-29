import type { User } from "@better-auth/core/db"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import * as z from "zod"
import { WAITLIST_ERROR_CODES } from "../index"
import { approveEntry, createMailbox, createWaitlistInstance, rejectEntry, seedUser } from "./harness"

afterEach(() => {
  vi.useRealTimers()
})

describe("join", () => {
  it("puts a new email on the waitlist and sends it a status link", async () => {
    const mailbox = createMailbox()
    const { auth } = await createWaitlistInstance({ ...mailbox.options })

    const res = await auth.api.joinWaitlist({ body: { email: "Ada@Example.COM" } })

    expect(res).toEqual({ success: true })
    expect(mailbox.sent).toHaveLength(1)
    const [mail] = mailbox.sent
    expect(mail?.email).toBe("ada@example.com")
    expect(mail?.reason).toBe("joined")
    expect(mail?.url).toBe(`https://app.test/waitlist?token=${mail?.token}`)

    const status = await auth.api.getWaitlistStatus({ query: { token: mailbox.tokenFor("ada@example.com") } })
    expect(status).toMatchObject({
      email: "ada@example.com",
      status: "pending",
      position: 1,
      queueLength: 1,
      referralCount: 0,
      emailConfirmed: false,
      invite: null,
    })
    expect(status.referralCode).toMatch(/^[a-z0-9]{8}$/)
  })

  it("normalises the email, so case variants are one entry", async () => {
    const mailbox = createMailbox()
    const { auth } = await createWaitlistInstance({ ...mailbox.options })

    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })
    await auth.api.joinWaitlist({ body: { email: "ADA@EXAMPLE.COM" } })

    const status = await auth.api.getWaitlistStatus({ query: { token: mailbox.tokenFor("ada@example.com") } })
    expect(status.queueLength).toBe(1)
  })

  it("returns an identical response for new, duplicate, existing-user, Guest and rejected emails", async () => {
    const mailbox = createMailbox()
    const { auth, client, db } = await createWaitlistInstance({ ...mailbox.options })
    await client.waitlist.join({ email: "dup@example.com" })
    await client.waitlist.join({ email: "rejected@example.com" })
    await rejectEntry({ auth }, "rejected@example.com")
    await seedUser({ auth, db }, "user@example.com", { password: "correct-horse-battery" })
    await seedUser({ auth, db }, "guest@example.com")

    const responses = await Promise.all(
      ["new@example.com", "dup@example.com", "user@example.com", "guest@example.com", "rejected@example.com"].map(
        (email) => client.waitlist.join({ email })
      )
    )

    for (const res of responses) {
      expect(res.error).toBeNull()
      expect(res.data).toEqual({ success: true })
    }
  })

  it.each([
    ["valid", "Analytical Engines"],
    ["invalid", "AE"],
  ])("returns an identical response for every kind of email when additionalFields input is %s", async (_, company) => {
    const mailbox = createMailbox()
    const { auth, customFetchImpl, db } = await createWaitlistInstance({
      ...mailbox.options,
      join: { autoApprove: ({ email }) => email.startsWith("vip") },
      schema: {
        waitlistEntry: {
          additionalFields: { company: { type: "string", required: false, validator: { input: z.string().min(3) } } },
        },
      },
    })
    const join = async (body: Record<string, string>) => {
      const res = await customFetchImpl("http://localhost:3000/api/auth/waitlist/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.text() }
    }
    await join({ email: "dup@example.com" })
    await join({ email: "rejected@example.com" })
    await rejectEntry({ auth }, "rejected@example.com")
    await seedUser({ auth, db }, "user@example.com", { password: "correct-horse-battery" })

    const responses = await Promise.all(
      ["new@example.com", "vip@example.com", "dup@example.com", "user@example.com", "rejected@example.com"].map(
        (email) => join({ email, company })
      )
    )

    expect(new Set(responses.map((res) => JSON.stringify(res))).size).toBe(1)
    expect(responses[0]?.status).toBe(company.length >= 3 ? 200 : 400)
  })

  it("validates the body: an email, and a name of at most 100 characters", async () => {
    const { client } = await createWaitlistInstance({})

    const ok = await client.waitlist.join({ email: "ada@example.com", name: "a".repeat(100) })
    const badEmail = await client.waitlist.join({ email: "not-an-email" })
    const longName = await client.waitlist.join({ email: "bob@example.com", name: "a".repeat(101) })
    const badToken = await client.waitlist.status({ query: { token: "" } })

    expect(ok.error).toBeNull()
    for (const res of [badEmail, longName, badToken]) expect(res.error?.status).toBe(400)
  })

  it("never changes an existing entry on a repeat join", async () => {
    const mailbox = createMailbox()
    const { auth, db } = await createWaitlistInstance({ ...mailbox.options })
    await auth.api.joinWaitlist({ body: { email: "first@example.com", name: "First" } })
    await auth.api.joinWaitlist({ body: { email: "second@example.com" } })
    await auth.api.joinWaitlist({ body: { email: "rejected@example.com" } })
    await rejectEntry({ auth }, "rejected@example.com")
    const token = mailbox.tokenFor("first@example.com")
    const rejectedToken = mailbox.tokenFor("rejected@example.com")
    const before = await auth.api.getWaitlistStatus({ query: { token } })

    await auth.api.joinWaitlist({ body: { email: "first@example.com", name: "Renamed" } })
    await auth.api.joinWaitlist({ body: { email: "rejected@example.com" } })

    expect(await auth.api.getWaitlistStatus({ query: { token } })).toEqual(before)
    expect((await auth.api.getWaitlistStatus({ query: { token: rejectedToken } })).status).toBe("rejected")
    const [entry] = await db.findMany<{ name: string }>({
      model: "waitlistEntry",
      where: [{ field: "email", value: "first@example.com" }],
    })
    expect(entry?.name).toBe("First")
  })

  it("gives 20 parallel joins of one email 1 entry, 20 successes and 1 status link", async () => {
    const mailbox = createMailbox()
    const { client, auth } = await createWaitlistInstance({ ...mailbox.options })

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => client.waitlist.join({ email: "race@example.com" }))
    )

    expect(responses.map((res) => res.data)).toEqual(Array.from({ length: 20 }, () => ({ success: true })))
    expect(mailbox.sent).toHaveLength(1)
    const status = await auth.api.getWaitlistStatus({ query: { token: mailbox.tokenFor("race@example.com") } })
    expect(status.queueLength).toBe(1)
  })
})

describe("option: statusLink.resendAfter", () => {
  it("re-sends the status link on a repeat join only after 600 s by default", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    const mailbox = createMailbox()
    const { auth } = await createWaitlistInstance({ ...mailbox.options })
    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })

    vi.advanceTimersByTime(599_000)
    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })
    expect(mailbox.sent.map((mail) => mail.reason)).toEqual(["joined"])

    vi.advanceTimersByTime(2_000)
    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })
    expect(mailbox.sent.map((mail) => mail.reason)).toEqual(["joined", "rejoined"])
    expect(mailbox.sent[1]?.token).toBe(mailbox.sent[0]?.token)

    vi.advanceTimersByTime(2_000)
    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })
    expect(mailbox.sent).toHaveLength(2)
  })

  it("re-sends to an entry never sent a link, and only that entry", async () => {
    const mailbox = createMailbox()
    const { auth, db } = await createWaitlistInstance({ ...mailbox.options })
    await auth.api.joinWaitlist({ body: { email: "other@example.com" } })
    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })
    await db.update({
      model: "waitlistEntry",
      where: [{ field: "email", value: "ada@example.com" }],
      update: { lastNotifiedAt: null },
    })

    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })

    expect(mailbox.sent.map((mail) => [mail.email, mail.reason])).toEqual([
      ["other@example.com", "joined"],
      ["ada@example.com", "joined"],
      ["ada@example.com", "rejoined"],
    ])
  })

  it("uses the configured interval", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    const mailbox = createMailbox()
    const { auth } = await createWaitlistInstance({
      ...mailbox.options,
      statusLink: { ...mailbox.options.statusLink, resendAfter: 60 },
    })
    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })

    vi.advanceTimersByTime(61_000)
    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })

    expect(mailbox.sent.map((mail) => mail.reason)).toEqual(["joined", "rejoined"])
  })
})

describe("option: onExistingUserJoin", () => {
  it.each([
    ["a password", { password: "correct-horse-battery" }],
    ["a Google login", { google: "google-sub-1" }],
  ])("is called, instead of creating an entry, when the email has %s", async (_, signIn) => {
    const mailbox = createMailbox()
    const calls: User[] = []
    const { auth, db } = await createWaitlistInstance({
      ...mailbox.options,
      onExistingUserJoin: async ({ user }) => {
        calls.push(user)
      },
    })
    await seedUser({ auth, db }, "user@example.com", signIn)

    const res = await auth.api.joinWaitlist({ body: { email: "User@Example.com" } })

    expect(res).toEqual({ success: true })
    expect(calls.map((user) => user.email)).toEqual(["user@example.com"])
    expect(mailbox.sent).toHaveLength(0)
  })
})

describe("join: a Guest (user with no account)", () => {
  it("is put on the waitlist, not told they already have an account", async () => {
    const mailbox = createMailbox()
    const notices: string[] = []
    const { auth, db } = await createWaitlistInstance({
      ...mailbox.options,
      onExistingUserJoin: async ({ user }) => {
        notices.push(user.email)
      },
    })
    await seedUser({ auth, db }, "friend@example.com")

    const res = await auth.api.joinWaitlist({ body: { email: "friend@example.com" } })

    expect(res).toEqual({ success: true })
    expect(notices).toEqual([])
    expect(mailbox.sent.map((m) => m.reason)).toEqual(["joined"])
  })
})

describe("option: join.enabled", () => {
  it("returns WAITLIST_CLOSED when false", async () => {
    const { client } = await createWaitlistInstance({ join: { enabled: false } })

    const res = await client.waitlist.join({ email: "ada@example.com" })

    expect(res.error?.status).toBe(403)
    expect(res.error?.code).toBe(WAITLIST_ERROR_CODES.WAITLIST_CLOSED.code)
  })
})

describe("option: join.maxEntries", () => {
  it("returns WAITLIST_FULL for new and existing emails once the pending count reaches the cap", async () => {
    const mailbox = createMailbox()
    const { auth, client } = await createWaitlistInstance({ ...mailbox.options, join: { maxEntries: 2 } })
    expect((await client.waitlist.join({ email: "a@example.com" })).error).toBeNull()
    expect((await client.waitlist.join({ email: "b@example.com" })).error).toBeNull()

    const newcomer = await client.waitlist.join({ email: "c@example.com" })
    const existing = await client.waitlist.join({ email: "a@example.com" })

    for (const res of [newcomer, existing]) {
      expect(res.error?.status).toBe(403)
      expect(res.error?.code).toBe(WAITLIST_ERROR_CODES.WAITLIST_FULL.code)
    }

    await approveEntry({ auth }, "a@example.com")
    expect((await client.waitlist.join({ email: "c@example.com" })).error).toBeNull()
  })
})

describe("option: join.allowedDomains", () => {
  it("matches the domain case-insensitively and rejects others with EMAIL_NOT_ALLOWED", async () => {
    const { client } = await createWaitlistInstance({ join: { allowedDomains: ["Example.com"] } })

    expect((await client.waitlist.join({ email: "ada@EXAMPLE.COM" })).error).toBeNull()
    const other = await client.waitlist.join({ email: "ada@example.org" })
    const subdomain = await client.waitlist.join({ email: "ada@mail.example.com" })

    for (const res of [other, subdomain]) {
      expect(res.error?.status).toBe(400)
      expect(res.error?.code).toBe(WAITLIST_ERROR_CODES.EMAIL_NOT_ALLOWED.code)
    }
  })
})

describe("option: join.validate", () => {
  it("rejects with EMAIL_NOT_ALLOWED when it returns false", async () => {
    const seen: { email: string; name?: string }[] = []
    const { client } = await createWaitlistInstance({
      join: {
        validate: async ({ email, name }) => {
          seen.push({ email, name })
          return !email.endsWith("@disposable.test")
        },
      },
    })

    expect((await client.waitlist.join({ email: "Ada@Example.com", name: "Ada" })).error).toBeNull()
    const res = await client.waitlist.join({ email: "spam@disposable.test" })

    expect(res.error?.status).toBe(400)
    expect(res.error?.code).toBe(WAITLIST_ERROR_CODES.EMAIL_NOT_ALLOWED.code)
    expect(seen[0]).toEqual({ email: "ada@example.com", name: "Ada" })
  })
})

describe("option: join.autoApprove", () => {
  it("creates the entry as approved with a fresh invite when true", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    const mailbox = createMailbox()
    const { auth } = await createWaitlistInstance({ ...mailbox.options, join: { autoApprove: true } })

    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })

    const status = await auth.api.getWaitlistStatus({ query: { token: mailbox.tokenFor("ada@example.com") } })
    expect(status).toMatchObject({
      status: "approved",
      position: null,
      queueLength: 0,
      invite: { expiresAt: new Date("2026-01-08T00:00:00Z"), expired: false },
    })
  })

  it("approves only the emails a predicate accepts", async () => {
    const mailbox = createMailbox()
    const { auth } = await createWaitlistInstance({
      ...mailbox.options,
      join: { autoApprove: ({ email }) => email.endsWith("@vip.test") },
    })

    await auth.api.joinWaitlist({ body: { email: "Boss@VIP.test" } })
    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })

    const vip = await auth.api.getWaitlistStatus({ query: { token: mailbox.tokenFor("boss@vip.test") } })
    const regular = await auth.api.getWaitlistStatus({ query: { token: mailbox.tokenFor("ada@example.com") } })
    expect(vip.status).toBe("approved")
    expect(regular.status).toBe("pending")
  })

  it("reports an expired invite as expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    const mailbox = createMailbox()
    const { auth } = await createWaitlistInstance({ ...mailbox.options, join: { autoApprove: true } })
    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })

    vi.setSystemTime(new Date("2026-01-08T00:00:01Z"))

    const status = await auth.api.getWaitlistStatus({ query: { token: mailbox.tokenFor("ada@example.com") } })
    expect(status.invite).toEqual({ expiresAt: new Date("2026-01-08T00:00:00Z"), expired: true })
  })
})
