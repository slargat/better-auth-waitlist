import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { type SendInviteData, type WaitlistOptions, waitlist } from "../index"
import { createWaitlistInstance, entryIdOf } from "./harness"
import { createLogger } from "./logger"

afterEach(() => {
  vi.useRealTimers()
})

function createInviteMailbox(extra: WaitlistOptions["invite"] = {}) {
  const sent: SendInviteData[] = []
  const options = {
    invite: { buildUrl: (code: string) => `https://app.test/register?invite=${code}`, ...extra },
    sendInvite: async (data: SendInviteData) => {
      sent.push(data)
    },
  } satisfies WaitlistOptions
  return { sent, options }
}

const NOW = new Date("2026-01-01T00:00:00Z")

async function setup(options: WaitlistOptions = {}) {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW })
  const mailbox = createInviteMailbox(options.invite)
  const instance = await createWaitlistInstance({ ...options, ...mailbox.options })
  const { api } = instance.auth
  const join = async (email: string) => {
    await api.joinWaitlist({ body: { email } })
    return entryIdOf(instance, email)
  }
  return { ...instance, api, sent: mailbox.sent, join }
}

describe("option: sendInvite", () => {
  it("fires once per issued invite, for approve, direct invite, resend and auto-approve, with the documented payload", async () => {
    const { api, sent, join } = await setup({ join: { autoApprove: ({ email }) => email.startsWith("auto") } })
    const ada = await join("ada@example.com")

    await api.approveWaitlistEntries({ body: { entryIds: [ada] } })
    await api.resendWaitlistInvite({ body: { entryId: ada } })
    await api.inviteToWaitlist({ body: { email: "direct@example.com" } })
    await api.joinWaitlist({ body: { email: "auto@example.com" } })

    expect(sent.map((mail) => [mail.email, mail.reason])).toEqual([
      ["ada@example.com", "approved"],
      ["ada@example.com", "resent"],
      ["direct@example.com", "direct"],
      ["auto@example.com", "auto"],
    ])
    for (const mail of sent) {
      expect(mail.code).toMatch(/^[A-Za-z0-9]{24}$/)
      expect(mail.url).toBe(`https://app.test/register?invite=${mail.code}`)
      expect(mail.expiresAt).toEqual(new Date("2026-01-08T00:00:00Z"))
      expect(mail.entry).toMatchObject({ email: mail.email, status: "approved" })
      expect(mail.entry).not.toHaveProperty("inviteCodeHash")
    }
    expect(new Set(sent.map((mail) => mail.code)).size).toBe(4)
  })

  it("fires once for a direct invite of an entry already on the list", async () => {
    const { api, sent, join } = await setup()
    await join("ada@example.com")

    await api.inviteToWaitlist({ body: { email: "ada@example.com" } })

    expect(sent.map((mail) => mail.reason)).toEqual(["direct"])
  })

  it("does not fire when the write didn't apply (skipped, invalid, missing)", async () => {
    const { api, sent, join } = await setup()
    const ada = await join("ada@example.com")
    await api.approveWaitlistEntries({ body: { entryIds: [ada] } })
    sent.length = 0

    await api.approveWaitlistEntries({ body: { entryIds: [ada, "missing"] } })
    const pending = await join("bob@example.com")
    await expect(api.resendWaitlistInvite({ body: { entryId: pending } })).rejects.toMatchObject({ statusCode: 409 })

    expect(sent).toEqual([])
  })

  it("sends the code the entry stores: a resend replaces it with a new one", async () => {
    const { api, sent, join } = await setup({ invite: { returnCodeToManager: true } })
    const ada = await join("ada@example.com")

    const approved = await api.approveWaitlistEntries({ body: { entryIds: [ada] } })
    const resent = await api.resendWaitlistInvite({ body: { entryId: ada } })

    expect(approved.results[0]?.code).toBe(sent[0]?.code)
    expect(resent.code).toBe(sent[1]?.code)
    expect(resent.code).not.toBe(approved.results[0]?.code)
  })

  it("does not change the response when it throws, and never logs the code or the url", async () => {
    const { lines, logger } = createLogger()
    vi.useFakeTimers({ toFake: ["Date"], now: NOW })
    const codes: string[] = []
    const instance = await createWaitlistInstance(
      {
        invite: { buildUrl: (code) => `https://app.test/register?invite=${code}`, returnCodeToManager: true },
        sendInvite: async ({ code, url }) => {
          codes.push(code)
          throw new Error(`mailer refused ${url} (code ${code})`, { cause: new Error(code) })
        },
      },
      { auth: { logger } }
    )
    await instance.auth.api.joinWaitlist({ body: { email: "ada@example.com" } })
    const ada = await entryIdOf(instance, "ada@example.com")

    const { results } = await instance.auth.api.approveWaitlistEntries({ body: { entryIds: [ada] } })

    expect(results[0]?.outcome).toBe("approved")
    const [code] = codes
    expect(code).toBeDefined()
    const errors = lines.filter((line) => line.level === "error")
    expect(errors.map((line) => line.message).join("\n")).toContain("sendInvite")
    for (const line of lines) expect(line.message).not.toContain(code ?? "unreachable")
  })
})

describe("option: invite.buildUrl", () => {
  it("is required when sendInvite is set: startup throws without it", () => {
    const options: WaitlistOptions = { sendInvite: async () => {} }

    expect(() => waitlist(options)).toThrow("invite.buildUrl")
  })

  describe("when it throws (a message quoting the code)", () => {
    async function failingBuildUrl() {
      const { lines, logger } = createLogger()
      const sent: SendInviteData[] = []
      const instance = await createWaitlistInstance(
        {
          invite: {
            returnCodeToManager: true,
            buildUrl: (code) => {
              throw new Error(`cannot build url for code ${code}`)
            },
          },
          sendInvite: async (data) => void sent.push(data),
          join: { autoApprove: ({ email }) => email.startsWith("auto") },
        },
        { auth: { logger } }
      )
      const { api } = instance.auth
      await api.joinWaitlist({ body: { email: "ada@example.com" } })
      const entryId = await entryIdOf(instance, "ada@example.com")
      const expectNoLeak = (code: string | undefined) => {
        expect(code).toMatch(/^[A-Za-z0-9]{24}$/)
        for (const line of lines) expect(line.message).not.toContain(code)
        expect(lines.some((line) => line.level === "error" && line.message.includes("[redacted]"))).toBe(true)
      }
      return { api, entryId, sent, expectNoLeak }
    }

    it("approve still succeeds, like a failing sendInvite, and the code is redacted from the log", async () => {
      const { api, entryId, sent, expectNoLeak } = await failingBuildUrl()

      const { results } = await api.approveWaitlistEntries({ body: { entryIds: [entryId] } })

      expect(results.map((result) => result.outcome)).toEqual(["approved"])
      expect(sent).toEqual([])
      expectNoLeak(results[0]?.code)
    })

    it("resend still succeeds, and the code is redacted from the log", async () => {
      const { api, entryId, expectNoLeak } = await failingBuildUrl()
      await api.approveWaitlistEntries({ body: { entryIds: [entryId] } })

      const resent = await api.resendWaitlistInvite({ body: { entryId } })

      expect(resent.entry.status).toBe("approved")
      expectNoLeak(resent.code)
    })

    it("an auto-approved join answers the same for a new and a repeat email", async () => {
      const { api } = await failingBuildUrl()

      const first = await api.joinWaitlist({ body: { email: "auto@example.com" } })
      const repeat = await api.joinWaitlist({ body: { email: "auto@example.com" } })

      expect([first, repeat]).toEqual([{ success: true }, { success: true }])
    })
  })
})

describe("option: invite.expiresIn", () => {
  it("sets the invite lifetime in seconds", async () => {
    const { api, sent, join } = await setup({ invite: { expiresIn: 3600 } })

    await api.approveWaitlistEntries({ body: { entryIds: [await join("ada@example.com")] } })

    expect(sent[0]?.expiresAt).toEqual(new Date("2026-01-01T01:00:00Z"))
  })

  it("null means the invite never expires", async () => {
    const { api, sent, join } = await setup({ invite: { expiresIn: null } })
    const ada = await join("ada@example.com")

    const { entry } = await api.inviteToWaitlist({ body: { email: "ada@example.com" } })

    expect(sent[0]?.expiresAt).toBeNull()
    expect(entry.inviteExpiresAt).toBeNull()
    vi.setSystemTime(new Date("2036-01-01T00:00:00Z"))
    expect((await api.getWaitlistStats({})).approvedExpired).toBe(0)
    expect(ada).toBe(entry.id)
  })
})

describe("option: invite.codeLength", () => {
  it("sets the length of the base62 code", async () => {
    const { api, sent, join } = await setup({ invite: { codeLength: 40 } })

    await api.approveWaitlistEntries({ body: { entryIds: [await join("ada@example.com")] } })

    expect(sent[0]?.code).toMatch(/^[A-Za-z0-9]{40}$/)
  })
})

describe("option: invite.returnCodeToManager", () => {
  it("is off by default: no response carries a code", async () => {
    const { api, join } = await setup()
    const ada = await join("ada@example.com")

    const approved = await api.approveWaitlistEntries({ body: { entryIds: [ada] } })
    const resent = await api.resendWaitlistInvite({ body: { entryId: ada } })
    const direct = await api.inviteToWaitlist({ body: { email: "direct@example.com" } })

    expect(approved.results[0]).not.toHaveProperty("code")
    expect(resent).not.toHaveProperty("code")
    expect(direct).not.toHaveProperty("code")
  })

  it("returns the raw code from approve, resend and invite, only for invites that were issued", async () => {
    const { api, sent, join } = await setup({ invite: { returnCodeToManager: true } })
    const ada = await join("ada@example.com")

    const approved = await api.approveWaitlistEntries({ body: { entryIds: [ada] } })
    const retry = await api.approveWaitlistEntries({ body: { entryIds: [ada] } })
    const resent = await api.resendWaitlistInvite({ body: { entryId: ada } })
    const direct = await api.inviteToWaitlist({ body: { email: "direct@example.com" } })

    expect(approved.results).toEqual([{ entryId: ada, outcome: "approved", code: sent[0]?.code }])
    expect(retry.results).toEqual([{ entryId: ada, outcome: "skipped" }])
    expect(resent.code).toBe(sent[1]?.code)
    expect(direct.code).toBe(sent[2]?.code)
  })
})
