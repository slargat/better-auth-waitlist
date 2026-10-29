import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import type { WaitlistEntry } from "../index"
import { defineConcurrencyCases, defineOrderingCases } from "./adapter-cases"
import { createMailbox, createWaitlistInstance } from "./harness"

const onPostgres = { testWith: "postgres" } as const

afterEach(() => {
  vi.useRealTimers()
})

describe("join (postgres)", () => {
  it("gives 20 parallel joins of one email 1 entry, 20 successes and 1 status link", async () => {
    const mailbox = createMailbox()
    const { client, db } = await createWaitlistInstance({ ...mailbox.options }, onPostgres)

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => client.waitlist.join({ email: "race@example.com" }))
    )

    expect(responses.map((res) => res.data)).toEqual(Array.from({ length: 20 }, () => ({ success: true })))
    expect(await db.count({ model: "waitlistEntry" })).toBe(1)
    expect(mailbox.sent).toHaveLength(1)
  })

  it("gives 50 concurrent joins the distinct positions 1..50", async () => {
    const mailbox = createMailbox()
    const { auth, client } = await createWaitlistInstance({ ...mailbox.options }, onPostgres)
    const emails = Array.from({ length: 50 }, (_, i) => `user${i}@example.com`)

    await Promise.all(emails.map((email) => client.waitlist.join({ email })))

    const positions = await Promise.all(
      emails.map(async (email) => {
        const status = await auth.api.getWaitlistStatus({ query: { token: mailbox.tokenFor(email) } })
        return status.position ?? 0
      })
    )
    expect([...positions].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
  })

  it("gives entries tied on queue score distinct, stable positions", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    const mailbox = createMailbox()
    const { auth } = await createWaitlistInstance({ ...mailbox.options }, onPostgres)
    const emails = ["a@example.com", "b@example.com", "c@example.com", "d@example.com"]
    for (const email of emails) await auth.api.joinWaitlist({ body: { email } })
    vi.useRealTimers()

    const read = () =>
      Promise.all(
        emails.map(async (email) => {
          const status = await auth.api.getWaitlistStatus({ query: { token: mailbox.tokenFor(email) } })
          return status.position ?? 0
        })
      )
    const first = await read()

    expect([...first].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    expect(await read()).toEqual(first)
  })

  it("round-trips a bigint queue score", async () => {
    const mailbox = createMailbox()
    const { auth, db } = await createWaitlistInstance({ ...mailbox.options }, onPostgres)

    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })

    const [entry] = await db.findMany<WaitlistEntry>({ model: "waitlistEntry" })
    expect(entry?.queueScore).toBe(entry?.createdAt.getTime())
  })
})

describe("guarded writes (postgres)", () => {
  defineConcurrencyCases("postgres")
})

describe("queue order (postgres)", () => {
  defineOrderingCases("postgres")
})
