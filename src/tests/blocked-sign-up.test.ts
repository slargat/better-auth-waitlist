import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { createBlockedSignUpInstance, defineBlockedSignUpCases, defineSingleUseCases } from "./blocked-sign-up-cases"
import { useFakeGoogle } from "./google"
import { createMailbox, createWaitlistInstance, entryOf, PASSWORD, rejectEntry, request } from "./harness"
import { createLogger } from "./logger"

useFakeGoogle()

afterEach(() => {
  vi.useRealTimers()
})

type Instance = Awaited<ReturnType<typeof createWaitlistInstance>>
const signUp = (instance: Instance, email: string) =>
  request(instance, "/sign-up/email", { body: { email, password: PASSWORD, name: email } })

defineBlockedSignUpCases("sqlite")
defineSingleUseCases("sqlite")

describe("option: gate.joinOnBlockedSignUp", () => {
  it("is off by default: a blocked sign-up puts nobody on the list", async () => {
    const mailbox = createMailbox()
    const instance = await createWaitlistInstance({ ...mailbox.options })

    const res = await signUp(instance, "ada@example.com")

    expect(res.status).toBe(403)
    expect(await entryOf(instance, "ada@example.com")).toBeUndefined()
    expect(mailbox.sent).toEqual([])
  })

  it("answers a blocked sign-up exactly as it does with the option off", async () => {
    const on = await createBlockedSignUpInstance("sqlite")
    const off = await createWaitlistInstance({})

    const [withJoin, without] = [await signUp(on, "ada@example.com"), await signUp(off, "ada@example.com")]
    await on.settle()

    expect({ status: withJoin.status, body: await withJoin.json() }).toEqual({
      status: without.status,
      body: await without.json(),
    })
  })

  it("joins under requireEmailVerification too, where the refusal is masked as success", async () => {
    const instance = await createBlockedSignUpInstance(
      "sqlite",
      {},
      { emailAndPassword: { enabled: true, requireEmailVerification: true } }
    )

    const res = await signUp(instance, "ada@example.com")
    await instance.settle()

    expect(res.status).toBe(200)
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "pending" })
  })

  it("keeps an existing entry as it is, and re-sends its status link only after statusLink.resendAfter", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    const instance = await createBlockedSignUpInstance("sqlite")
    await instance.auth.api.joinWaitlist({ body: { email: "pending@example.com" } })
    await instance.auth.api.joinWaitlist({ body: { email: "rejected@example.com" } })
    await rejectEntry(instance, "rejected@example.com")
    const before = await Promise.all(["pending@example.com", "rejected@example.com"].map((e) => entryOf(instance, e)))
    instance.mailbox.sent.length = 0
    instance.joins.length = 0

    await signUp(instance, "pending@example.com")
    await signUp(instance, "rejected@example.com")
    await instance.settle()
    expect(instance.mailbox.sent).toEqual([])

    vi.advanceTimersByTime(601_000)
    await signUp(instance, "pending@example.com")
    await signUp(instance, "rejected@example.com")
    await instance.settle()

    expect(instance.mailbox.sent.map((mail) => [mail.email, mail.reason])).toEqual([
      ["pending@example.com", "blocked-sign-up"],
      ["rejected@example.com", "blocked-sign-up"],
    ])
    const after = await Promise.all(["pending@example.com", "rejected@example.com"].map((e) => entryOf(instance, e)))
    expect(after.map((entry) => [entry?.id, entry?.status, entry?.queueScore])).toEqual(
      before.map((entry) => [entry?.id, entry?.status, entry?.queueScore])
    )
    expect(instance.joins.map((join) => join.source)).toEqual([])
  })

  it("follows the join rules: nobody joins a closed or full list, or with a disallowed email", async () => {
    const closed = await createBlockedSignUpInstance("sqlite", { join: { enabled: false } })
    const domains = await createBlockedSignUpInstance("sqlite", { join: { allowedDomains: ["example.com"] } })
    const full = await createBlockedSignUpInstance("sqlite", { join: { maxEntries: 0 } })

    await signUp(closed, "ada@example.com")
    await signUp(domains, "ada@other.test")
    await signUp(full, "ada@example.com")
    await Promise.all([closed.settle(), domains.settle(), full.settle()])

    expect(await entryOf(closed, "ada@example.com")).toBeUndefined()
    expect(await entryOf(domains, "ada@other.test")).toBeUndefined()
    expect(await entryOf(full, "ada@example.com")).toBeUndefined()
  })

  it("counts a join.validate that throws as not allowed, and logs it", async () => {
    const { lines, logger } = createLogger()
    const mailbox = createMailbox()
    const instance = await createWaitlistInstance(
      {
        ...mailbox.options,
        gate: { joinOnBlockedSignUp: true },
        join: {
          validate: () => {
            throw new Error("validator down")
          },
        },
      },
      { auth: { logger } }
    )

    const res = await signUp(instance, "ada@example.com")
    await vi.waitFor(() =>
      expect(lines.some((line) => line.level === "error" && line.message.includes("join.validate threw"))).toBe(true)
    )

    expect(res.status).toBe(403)
    expect(await entryOf(instance, "ada@example.com")).toBeUndefined()
  })

  it("still joins without a background-task handler, and warns at startup that the work is detached", async () => {
    const { lines, logger } = createLogger()
    const mailbox = createMailbox()
    const instance = await createWaitlistInstance(
      { ...mailbox.options, gate: { joinOnBlockedSignUp: true } },
      { auth: { logger } }
    )
    await instance.auth.$context

    await signUp(instance, "ada@example.com")

    await vi.waitFor(async () =>
      expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "pending" })
    )
    const warnings = lines.filter((line) => line.level === "warn" && line.message.includes("joinOnBlockedSignUp"))
    expect(warnings).toHaveLength(1)
  })

  it("doesn't warn with a background-task handler", async () => {
    const { lines, logger } = createLogger()
    const instance = await createWaitlistInstance(
      { gate: { joinOnBlockedSignUp: true } },
      { auth: { logger, advanced: { backgroundTasks: { handler: () => {} } } } }
    )
    await instance.auth.$context

    expect(lines.filter((line) => line.message.includes("joinOnBlockedSignUp"))).toEqual([])
  })
})
