import { describe, expect, it } from "vite-plus/test"
import { createMailbox, createWaitlistInstance } from "./harness"

const statusesOf = (responses: { error: { status: number } | null }[]) =>
  responses.map((res) => res.error?.status ?? 200)

async function repeat<T>(count: number, run: (i: number) => Promise<T>) {
  const results: T[] = []
  for (let i = 0; i < count; i++) results.push(await run(i))
  return results
}

async function withJoinedEntry(options: Parameters<typeof createWaitlistInstance>[0] = {}) {
  const mailbox = createMailbox()
  const instance = await createWaitlistInstance({ ...mailbox.options, ...options }, { rateLimit: true })
  await instance.auth.api.joinWaitlist({ body: { email: "ada@example.com" } })
  return { ...instance, token: mailbox.tokenFor("ada@example.com") }
}

describe("option: rateLimit", () => {
  it("limits join to 5 per 60 s by default", async () => {
    const { client } = await createWaitlistInstance({}, { rateLimit: true })

    const responses = await repeat(6, (i) => client.waitlist.join({ email: `user${i}@example.com` }))

    expect(statusesOf(responses)).toEqual([200, 200, 200, 200, 200, 429])
  })

  it("limits status to 30 per 60 s by default", async () => {
    const { client, token } = await withJoinedEntry()

    const responses = await repeat(31, () => client.waitlist.status({ query: { token } }))

    expect(statusesOf(responses).slice(29)).toEqual([200, 429])
  })

  it("limits confirm to 10 per 60 s by default", async () => {
    const { client, token } = await withJoinedEntry()

    const responses = await repeat(11, () => client.waitlist.confirm({ token }))

    expect(statusesOf(responses).slice(9)).toEqual([200, 429])
  })

  it("limits invite accept to 10 per 60 s by default", async () => {
    const { client } = await createWaitlistInstance({}, { rateLimit: true })

    const responses = await repeat(11, (i) => client.waitlist.invite.accept({ code: `guess-${i}` }))

    expect(statusesOf(responses).slice(9)).toEqual([200, 429])
  })

  it("applies an override for one endpoint and keeps the defaults for the others", async () => {
    const { client, token } = await withJoinedEntry({ rateLimit: { status: { window: 60, max: 2 } } })

    const status = await repeat(3, () => client.waitlist.status({ query: { token } }))
    const confirm = await repeat(3, () => client.waitlist.confirm({ token }))

    expect(statusesOf(status)).toEqual([200, 200, 429])
    expect(statusesOf(confirm)).toEqual([200, 200, 200])
  })

  it("leaves only Better Auth's global limit when false", async () => {
    const { client } = await createWaitlistInstance({ rateLimit: false }, { rateLimit: true })

    const responses = await repeat(6, (i) => client.waitlist.join({ email: `user${i}@example.com` }))

    expect(statusesOf(responses)).toEqual([200, 200, 200, 200, 200, 200])
  })
})
