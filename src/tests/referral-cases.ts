import { memoryAdapter } from "better-auth/adapters/memory"
import { expect, it } from "vite-plus/test"
import type { OnReferralSuccessData, WaitlistOptions } from "../index"
import { createMailbox, createWaitlistInstance, entryOf, failRegisterWrites, PASSWORD, request } from "./harness"

export async function createReferralInstance(
  options: WaitlistOptions = {},
  config: Parameters<typeof createWaitlistInstance>[1] = {}
) {
  const mailbox = createMailbox()
  const successes: OnReferralSuccessData[] = []
  const instance = await createWaitlistInstance(
    {
      ...mailbox.options,
      invite: { returnCodeToManager: true },
      onReferralSuccess: (data) => void successes.push(data),
      ...options,
    },
    config
  )
  const { api } = instance.auth
  const tokenFor = (email: string) => mailbox.tokenFor(email)
  const status = (email: string) => api.getWaitlistStatus({ query: { token: tokenFor(email) } })
  const join = (email: string, referralCode?: string) =>
    api.joinWaitlist({ body: { email, ...(referralCode === undefined ? {} : { referralCode }) } })
  const confirm = (email: string) => api.confirmWaitlistEntry({ body: { token: tokenFor(email) } })
  const codeOf = async (email: string) => (await status(email)).referralCode
  const signUp = async (email: string) => {
    const existing = await entryOf(instance, email)
    const issued = existing
      ? (await api.approveWaitlistEntries({ body: { entryIds: [existing.id] } })).results[0]
      : await api.inviteToWaitlist({ body: { email } })
    const code = issued && "code" in issued && typeof issued.code === "string" ? issued.code : ""
    return request(instance, "/sign-up/email", {
      body: { email, password: PASSWORD, name: email },
      headers: { "x-waitlist-invite": code },
    })
  }
  return {
    ...instance,
    api,
    mailbox,
    successes,
    status,
    join,
    confirm,
    codeOf,
    signUp,
    entry: (email: string) => entryOf(instance, email),
  }
}

export function defineReferralConcurrencyCases(testWith: "sqlite" | "postgres") {
  it("fires onReferralSuccess once under 20 concurrent confirms of the referred entry", async () => {
    const { join, confirm, codeOf, successes, status } = await createReferralInstance({}, { testWith })
    await join("ada@example.com")
    await join("bob@example.com", await codeOf("ada@example.com"))

    const responses = await Promise.all(Array.from({ length: 20 }, () => confirm("bob@example.com")))

    expect(responses).toEqual(Array.from({ length: 20 }, () => ({ success: true })))
    expect(successes).toHaveLength(1)
    expect(successes[0]).toMatchObject({
      referrer: { email: "ada@example.com" },
      referred: { email: "bob@example.com", referralSucceeded: true },
      referralCount: 1,
    })
    expect((await status("ada@example.com")).referralCount).toBe(1)
  })

  it("counts every one of 20 referred entries confirming at once, each claimed once", async () => {
    const { join, confirm, codeOf, successes, status } = await createReferralInstance({}, { testWith })
    await join("ada@example.com")
    const code = await codeOf("ada@example.com")
    const referred = Array.from({ length: 20 }, (_, i) => `friend${i}@example.com`)
    for (const email of referred) await join(email, code)

    await Promise.all(referred.flatMap((email) => [confirm(email), confirm(email)]))

    expect(successes.map((success) => success.referred.email).sort()).toEqual([...referred].sort())
    expect(Math.max(...successes.map((success) => success.referralCount))).toBe(20)
    expect((await status("ada@example.com")).referralCount).toBe(20)
  })

  it("fires once when 20 status reads repair a registration that failed after sign-up (successOn register)", async () => {
    const instance = await createReferralInstance({ referral: { successOn: "register" } }, { testWith })
    const { join, codeOf, signUp, successes, status, entry } = instance
    await join("ada@example.com")
    await join("bob@example.com", await codeOf("ada@example.com"))
    const undo = await failRegisterWrites(instance)
    expect((await signUp("bob@example.com")).status).toBe(200)
    await undo()
    expect(successes).toEqual([])

    await Promise.all(Array.from({ length: 20 }, () => status("bob@example.com")))

    expect(await entry("bob@example.com")).toMatchObject({ status: "registered", referralSucceeded: true })
    expect(successes).toHaveLength(1)
    expect(successes[0]).toMatchObject({ referred: { email: "bob@example.com" }, referralCount: 1 })
  })
}

export type ReferralBackend = "sqlite" | "postgres" | "memory"

export const onBackend = (backend: ReferralBackend): Parameters<typeof createWaitlistInstance>[1] =>
  backend === "memory"
    ? {
        auth: {
          database: memoryAdapter({
            user: [],
            session: [],
            account: [],
            verification: [],
            waitlistEntry: [],
            rateLimit: [],
          }),
        },
      }
    : { testWith: backend }

export function defineReferrerErasureCases(backend: ReferralBackend) {
  async function referred() {
    const instance = await createReferralInstance({}, onBackend(backend))
    await instance.join("ada@example.com")
    const code = await instance.codeOf("ada@example.com")
    await instance.join("bob@example.com", code)
    await instance.join("carol@example.com", code)
    const ada = await instance.entry("ada@example.com")
    return { ...instance, adaId: ada?.id ?? "" }
  }
  async function expectUnlinked(instance: Awaited<ReturnType<typeof referred>>) {
    await instance.confirm("bob@example.com")
    expect(await instance.entry("bob@example.com")).toMatchObject({
      emailConfirmed: true,
      referredById: null,
      referralSucceeded: false,
    })
    expect((await instance.entry("carol@example.com"))?.referredById).toBeNull()
    expect(instance.successes).toEqual([])
    expect((await instance.api.getWaitlistStats({})).successfulReferrals).toBe(0)
    const listed = await instance.api.listWaitlistEntries({ query: { referredById: instance.adaId } })
    expect(listed).toMatchObject({ entries: [], total: 0 })
  }

  it("unlinks the referred entries when a manager deletes the referrer, so nothing is claimed", async () => {
    const instance = await referred()

    await instance.api.deleteWaitlistEntry({ body: { entryId: instance.adaId } })

    await expectUnlinked(instance)
  })

  it("unlinks the referred entries when the referrer's user is deleted, so nothing is claimed", async () => {
    const instance = await referred()
    expect((await instance.signUp("ada@example.com")).status).toBe(200)
    const { internalAdapter } = await instance.auth.$context
    const user = await internalAdapter.findUserByEmail("ada@example.com")

    await internalAdapter.deleteUser(user?.user.id ?? "")

    expect(await instance.entry("ada@example.com")).toBeUndefined()
    await expectUnlinked(instance)
  })

  it("leaves the referrals of other referrers alone", async () => {
    const instance = await referred()
    await instance.join("zed@example.com")
    await instance.join("dan@example.com", await instance.codeOf("zed@example.com"))
    const zed = await instance.entry("zed@example.com")

    await instance.api.deleteWaitlistEntry({ body: { entryId: instance.adaId } })
    await instance.confirm("dan@example.com")

    expect((await instance.entry("dan@example.com"))?.referredById).toBe(zed?.id)
    expect(instance.successes.map((success) => success.referred.email)).toEqual(["dan@example.com"])
  })
}

export function defineMalformedCodeCases(backend: "sqlite" | "postgres") {
  it("ignores a malformed code like an unknown one: same response, no referrer, same host calls", async () => {
    const calls: string[] = []
    const instance = await createReferralInstance(
      {
        referral: {
          canonicalizeEmail: (email) => {
            calls.push(email)
            return email
          },
        },
      },
      onBackend(backend)
    )
    let code = ""
    for (let i = 0; i < 60 && !code.includes("k"); i++) {
      await instance.join(`referrer${i}@example.com`)
      code = await instance.codeOf(`referrer${i}@example.com`)
    }
    expect(code).toContain("k")
    const codes = {
      unknown: "zzzzzzzz",
      nul: `${code.slice(0, 4)}\u0000${code.slice(4)}`,
      kelvin: code.replace("k", "K"),
      toolong: `${code}${"a".repeat(65 - code.length)}`,
      symbols: `${code.slice(0, 7)}!`,
    }

    for (const [name, referralCode] of Object.entries(codes)) {
      calls.length = 0
      const email = `${name}@example.com`
      const res = await request(instance, "/waitlist/join", { body: { email, referralCode } })

      expect([name, res.status, await res.json()]).toEqual([name, 200, { success: true }])
      expect([name, calls.length]).toEqual([name, 2])
      expect(await instance.entry(email)).toMatchObject({ status: "pending", referredById: null })
    }
  })
}
