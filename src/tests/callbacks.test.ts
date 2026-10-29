import { describe, expect, it, vi } from "vite-plus/test"
import { type OnJoinData, type WaitlistOptions, waitlist } from "../index"
import { createMailbox, createWaitlistInstance, seedUser } from "./harness"
import { createLogger } from "./logger"

describe("option: sendStatusLink", () => {
  it("runs once per new entry, after the entry is written, with the documented payload", async () => {
    const mailbox = createMailbox()
    let statusSeenInCallback: unknown = null
    const instance = await createWaitlistInstance({
      ...mailbox.options,
      sendStatusLink: async (data) => {
        await mailbox.options.sendStatusLink(data)
        statusSeenInCallback = await instance.auth.api.getWaitlistStatus({ query: { token: data.token } })
      },
    })

    await instance.auth.api.joinWaitlist({ body: { email: "ada@example.com", name: "Ada" } })

    expect(mailbox.sent).toHaveLength(1)
    const [mail] = mailbox.sent
    expect(mail).toMatchObject({ email: "ada@example.com", reason: "joined" })
    expect(mail?.entry).toMatchObject({ email: "ada@example.com", name: "Ada", status: "pending" })
    expect(mail?.entry).not.toHaveProperty("inviteCodeHash")
    expect(statusSeenInCallback).toMatchObject({ status: "pending", position: 1 })
  })

  it("does not change the response when it throws, and the error is logged", async () => {
    const { lines, logger } = createLogger()
    const { client } = await createWaitlistInstance(
      {
        statusLink: { buildUrl: (token) => token },
        sendStatusLink: async () => {
          throw new Error("mailer down")
        },
      },
      { auth: { logger } }
    )

    const res = await client.waitlist.join({ email: "ada@example.com" })

    expect(res.error).toBeNull()
    expect(res.data).toEqual({ success: true })
    expect(lines.some((line) => line.level === "error" && line.message.includes("sendStatusLink"))).toBe(true)
  })

  it("is scheduled through advanced.backgroundTasks when configured", async () => {
    const background: Promise<unknown>[] = []
    let release = () => {}
    const sending = new Promise<void>((resolve) => {
      release = resolve
    })
    const sent: string[] = []
    const { auth } = await createWaitlistInstance(
      {
        statusLink: { buildUrl: (token) => token },
        sendStatusLink: async ({ email }) => {
          await sending
          sent.push(email)
        },
      },
      { auth: { advanced: { backgroundTasks: { handler: (promise) => background.push(promise) } } } }
    )

    expect(await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })).toEqual({ success: true })
    expect(sent).toEqual([])
    expect(background).toHaveLength(1)

    release()
    await Promise.all(background)
    expect(sent).toEqual(["ada@example.com"])
  })

  it("warns at startup when it is missing", async () => {
    const { lines, logger } = createLogger()
    const { auth } = await createWaitlistInstance({}, { auth: { logger } })
    await auth.$context

    expect(lines.some((line) => line.level === "warn" && line.message.includes("sendStatusLink"))).toBe(true)
  })
})

describe("email callbacks without advanced.backgroundTasks", () => {
  const timingWarning = (lines: { level: string; message: string }[]) =>
    lines.filter((line) => line.level === "warn" && line.message.includes("advanced.backgroundTasks"))

  it.each([
    ["sendStatusLink", { ...createMailbox().options }],
    ["onExistingUserJoin", { onExistingUserJoin: async () => {} }],
  ] as const)(
    "warn at startup when %s is set, since awaiting it makes join timing reveal membership",
    async (name, options) => {
      const { lines, logger } = createLogger()
      const { auth } = await createWaitlistInstance(options, { auth: { logger } })
      await auth.$context

      const warnings = timingWarning(lines)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.message).toContain(name)
    }
  )

  it("do not warn when a background task handler is configured", async () => {
    const { lines, logger } = createLogger()
    const { auth } = await createWaitlistInstance(
      { ...createMailbox().options, onExistingUserJoin: async () => {} },
      { auth: { logger, advanced: { backgroundTasks: { handler: () => {} } } } }
    )
    await auth.$context

    expect(timingWarning(lines)).toEqual([])
  })

  it("warn about sendInvite only with join.autoApprove, the one case where join sends an invite", async () => {
    const invite = { invite: { buildUrl: (code: string) => code }, sendInvite: async () => {} }
    const auto = createLogger()
    const manual = createLogger()
    await (
      await createWaitlistInstance({ ...invite, join: { autoApprove: true } }, { auth: { logger: auto.logger } })
    ).auth.$context
    await (
      await createWaitlistInstance(invite, { auth: { logger: manual.logger } })
    ).auth.$context

    expect(timingWarning(auto.lines).map((line) => line.message.includes("sendInvite"))).toEqual([true])
    expect(timingWarning(manual.lines)).toEqual([])
  })
})

describe("option: statusLink.buildUrl", () => {
  it("is required when sendStatusLink is set: startup throws without it", async () => {
    const options: WaitlistOptions = { sendStatusLink: async () => {} }

    expect(() => waitlist(options)).toThrow("statusLink.buildUrl")
  })

  it("throwing answers a new and a repeat join the same, and the token is redacted from the log", async () => {
    const { lines, logger } = createLogger()
    const tokens: string[] = []
    const { auth } = await createWaitlistInstance(
      {
        statusLink: {
          resendAfter: 0,
          buildUrl: (token) => {
            tokens.push(token)
            throw new Error(`cannot build url for token ${token}`)
          },
        },
        sendStatusLink: async () => {},
      },
      { auth: { logger } }
    )

    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    const first = await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })
    vi.advanceTimersByTime(1000)
    const repeat = await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })
    vi.useRealTimers()

    expect([first, repeat]).toEqual([{ success: true }, { success: true }])
    expect(tokens).toHaveLength(2)
    for (const line of lines) for (const token of tokens) expect(line.message).not.toContain(token)
    expect(lines.filter((line) => line.level === "error" && line.message.includes("[redacted]"))).toHaveLength(2)
  })

  it("builds the url handed to sendStatusLink", async () => {
    const mailbox = createMailbox()
    const { auth } = await createWaitlistInstance({
      ...mailbox.options,
      statusLink: { buildUrl: (token) => `https://example.test/status/${token}` },
    })

    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })

    expect(mailbox.sent[0]?.url).toBe(`https://example.test/status/${mailbox.tokenFor("ada@example.com")}`)
  })
})

describe("option: onJoin", () => {
  it("runs once per created entry with the entry, no referrer and source join", async () => {
    const calls: OnJoinData[] = []
    const { auth } = await createWaitlistInstance({
      onJoin: (data) => {
        calls.push(data)
      },
    })

    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })
    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ referrer: null, source: "join", entry: { email: "ada@example.com" } })
    expect(calls[0]?.entry).not.toHaveProperty("inviteCodeHash")
  })

  it("does not change the response when it throws", async () => {
    const { client } = await createWaitlistInstance({
      onJoin: () => {
        throw new Error("boom")
      },
    })

    const res = await client.waitlist.join({ email: "ada@example.com" })

    expect(res.data).toEqual({ success: true })
  })

  it("is not called when the write fails", async () => {
    const calls: OnJoinData[] = []
    const { client } = await createWaitlistInstance({
      join: { maxEntries: 0 },
      onJoin: (data) => {
        calls.push(data)
      },
    })

    await client.waitlist.join({ email: "ada@example.com" })

    expect(calls).toEqual([])
  })
})

describe("onExistingUserJoin errors", () => {
  it("do not change the response", async () => {
    const { auth, client, db } = await createWaitlistInstance({
      onExistingUserJoin: async () => {
        throw new Error("boom")
      },
    })
    await seedUser({ auth, db }, "user@example.com", { password: "correct-horse-battery" })

    const res = await client.waitlist.join({ email: "user@example.com" })

    expect(res.data).toEqual({ success: true })
  })
})
