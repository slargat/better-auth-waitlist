import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { WAITLIST_ERROR_CODES } from "../index"
import { approveEntry, createMailbox, createWaitlistInstance, rejectEntry } from "./harness"

afterEach(() => {
  vi.useRealTimers()
})

async function joinAll(emails: string[], stepMs = 1000) {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
  const mailbox = createMailbox()
  const instance = await createWaitlistInstance({ ...mailbox.options })
  for (const email of emails) {
    await instance.auth.api.joinWaitlist({ body: { email } })
    vi.advanceTimersByTime(stepMs)
  }
  const statusOf = (email: string) => instance.auth.api.getWaitlistStatus({ query: { token: mailbox.tokenFor(email) } })
  return { ...instance, mailbox, statusOf }
}

describe("status token", () => {
  it("rejects malformed, forged and foreign tokens with INVALID_STATUS_TOKEN", async () => {
    const { client, mailbox } = await joinAll(["ada@example.com", "bob@example.com"])
    const ada = mailbox.tokenFor("ada@example.com")
    const bob = mailbox.tokenFor("bob@example.com")
    const [adaId, adaSig] = ada.split(".")
    const [bobId] = bob.split(".")
    const other = createMailbox()
    const otherInstance = await createWaitlistInstance(
      { ...other.options },
      { auth: { secret: "a-different-secret-that-is-long-enough-for-validation" } }
    )
    await otherInstance.auth.api.joinWaitlist({ body: { email: "ada@example.com" } })

    const tokens = [
      "garbage",
      `${adaId}.`,
      `.${adaSig}`,
      `${adaId}.${adaSig}x`,
      `${bobId}.${adaSig}`,
      other.tokenFor("ada@example.com"),
    ]
    for (const token of tokens) {
      const res = await client.waitlist.status({ query: { token } })
      expect(res.error?.status, token).toBe(400)
      expect(res.error?.code, token).toBe(WAITLIST_ERROR_CODES.INVALID_STATUS_TOKEN.code)
    }
  })

  it("is rejected once the entry no longer exists", async () => {
    const { client, db, mailbox } = await joinAll(["ada@example.com"])
    await db.delete({ model: "waitlistEntry", where: [{ field: "email", value: "ada@example.com" }] })

    const res = await client.waitlist.status({ query: { token: mailbox.tokenFor("ada@example.com") } })

    expect(res.error?.code).toBe(WAITLIST_ERROR_CODES.INVALID_STATUS_TOKEN.code)
  })

  it("is accepted over HTTP", async () => {
    const { client, mailbox } = await joinAll(["ada@example.com"])

    const res = await client.waitlist.status({ query: { token: mailbox.tokenFor("ada@example.com") } })

    expect(res.error).toBeNull()
    expect(res.data?.position).toBe(1)
  })
})

describe("position", () => {
  it("is the join order among pending entries", async () => {
    const emails = ["a@example.com", "b@example.com", "c@example.com"]
    const { statusOf } = await joinAll(emails)

    const statuses = await Promise.all(emails.map(statusOf))

    expect(statuses.map((status) => status.position)).toEqual([1, 2, 3])
    expect(statuses.map((status) => status.queueLength)).toEqual([3, 3, 3])
  })

  it("compacts when an entry ahead leaves pending, and is null for non-pending entries", async () => {
    const emails = ["a@example.com", "b@example.com", "c@example.com", "d@example.com"]
    const { auth, statusOf } = await joinAll(emails)

    await approveEntry({ auth }, "a@example.com")
    await rejectEntry({ auth }, "c@example.com")

    const statuses = await Promise.all(emails.map(statusOf))
    expect(statuses.map((status) => [status.status, status.position])).toEqual([
      ["approved", null],
      ["pending", 1],
      ["rejected", null],
      ["pending", 2],
    ])
    expect(statuses[0]?.queueLength).toBe(2)
  })

  it("breaks ties in queue score by id", async () => {
    const emails = ["a@example.com", "b@example.com", "c@example.com", "d@example.com"]
    const { mailbox, statusOf } = await joinAll(emails, 0)

    const statuses = await Promise.all(emails.map(statusOf))

    const idOf = (email: string) => mailbox.tokenFor(email).split(".")[0] ?? ""
    const byId = [...emails].sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1))
    expect(statuses.map((status) => status.position)).toEqual(emails.map((email) => byId.indexOf(email) + 1))
  })

  it("gives 50 concurrent joins the distinct positions 1..50", async () => {
    const mailbox = createMailbox()
    const { auth, client } = await createWaitlistInstance({ ...mailbox.options })
    const emails = Array.from({ length: 50 }, (_, i) => `user${i}@example.com`)

    await Promise.all(emails.map((email) => client.waitlist.join({ email })))

    const positions = await Promise.all(
      emails.map(async (email) => {
        const status = await auth.api.getWaitlistStatus({ query: { token: mailbox.tokenFor(email) } })
        return status.position
      })
    )
    expect([...positions].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
  })
})

describe("confirm", () => {
  it("confirms the entry's inbox, idempotently", async () => {
    const { auth, mailbox, statusOf } = await joinAll(["ada@example.com"])
    const token = mailbox.tokenFor("ada@example.com")

    expect(await auth.api.confirmWaitlistEntry({ body: { token } })).toEqual({ success: true })
    expect(await auth.api.confirmWaitlistEntry({ body: { token } })).toEqual({ success: true })

    expect((await statusOf("ada@example.com")).emailConfirmed).toBe(true)
  })

  it("keeps the first confirmation time on repeat confirms", async () => {
    const { auth, db, mailbox } = await joinAll(["ada@example.com"])
    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"))
    const token = mailbox.tokenFor("ada@example.com")

    await auth.api.confirmWaitlistEntry({ body: { token } })
    vi.advanceTimersByTime(60_000)
    await auth.api.confirmWaitlistEntry({ body: { token } })

    const [entry] = await db.findMany<{ confirmedAt: Date }>({
      model: "waitlistEntry",
      where: [{ field: "email", value: "ada@example.com" }],
    })
    expect(entry?.confirmedAt).toEqual(new Date("2026-02-01T00:00:00Z"))
  })

  it("is not triggered by reading the status (link prefetching)", async () => {
    const { statusOf } = await joinAll(["ada@example.com"])

    await statusOf("ada@example.com")

    expect((await statusOf("ada@example.com")).emailConfirmed).toBe(false)
  })

  it("rejects an invalid token with INVALID_STATUS_TOKEN", async () => {
    const { client } = await joinAll(["ada@example.com"])

    const res = await client.waitlist.confirm({ token: "nope.nope" })

    expect(res.error?.status).toBe(400)
    expect(res.error?.code).toBe(WAITLIST_ERROR_CODES.INVALID_STATUS_TOKEN.code)
  })
})
