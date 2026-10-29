import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import type { OnJoinData } from "../index"
import { createBackgroundTasks } from "./blocked-sign-up-cases"
import { PASSWORD, request } from "./harness"
import { createLogger } from "./logger"
import {
  createReferralInstance,
  defineMalformedCodeCases,
  defineReferralConcurrencyCases,
  defineReferrerErasureCases,
} from "./referral-cases"

afterEach(() => {
  vi.useRealTimers()
})

type Auth = Awaited<ReturnType<typeof createReferralInstance>>["auth"]

async function armAfterClaim(auth: Auth) {
  const { adapter } = await auth.$context
  const { incrementOne, count } = adapter
  let claimed = false
  let fired = false
  adapter.incrementOne = async <T>(data: Parameters<typeof incrementOne>[0]) => {
    const row = await incrementOne<T>(data)
    if (row && data.set?.referralSucceeded === true) claimed = true
    return row
  }
  adapter.count = async (data) => {
    if (claimed && !fired && data.where?.some((clause) => clause.field === "referralSucceeded")) {
      fired = true
      throw new Error("transient db blip")
    }
    return count(data)
  }
  return { fired: () => fired }
}

async function armBeforeClaim(auth: Auth) {
  const { adapter } = await auth.$context
  const { count } = adapter
  let fired = false
  adapter.count = async (data) => {
    if (!fired && data.where?.some((clause) => clause.field === "referralSucceeded")) {
      fired = true
      throw new Error("transient db blip")
    }
    return count(data)
  }
  return { fired: () => fired }
}

describe("referral tracking", () => {
  it("records the referrer when an entry joins with a valid referral code", async () => {
    const { join, codeOf, entry } = await createReferralInstance()
    await join("ada@example.com")

    await join("bob@example.com", await codeOf("ada@example.com"))

    const ada = await entry("ada@example.com")
    expect(await entry("bob@example.com")).toMatchObject({ referredById: ada?.id, referralSucceeded: false })
  })

  it("ignores an unknown referral code silently", async () => {
    const { join, entry } = await createReferralInstance()

    expect(await join("bob@example.com", "zzzzzzzz")).toEqual({ success: true })

    expect(await entry("bob@example.com")).toMatchObject({ status: "pending", referredById: null })
  })

  it("matches the code case-insensitively and with surrounding spaces", async () => {
    const { join, codeOf, entry } = await createReferralInstance()
    await join("ada@example.com")

    await join("bob@example.com", ` ${(await codeOf("ada@example.com")).toUpperCase()} `)

    expect((await entry("bob@example.com"))?.referredById).toBe((await entry("ada@example.com"))?.id)
  })

  it("answers a join identically whether its referral code exists, is unknown or is the joiner's own", async () => {
    const instance = await createReferralInstance()
    await instance.join("ada@example.com")
    const code = await instance.codeOf("ada@example.com")
    const raw = async (email: string, referralCode: string) => {
      const res = await request(instance, "/waitlist/join", { body: { email, referralCode } })
      return JSON.stringify([res.status, await res.json()])
    }

    const responses = [
      await raw("bob@example.com", code),
      await raw("carol@example.com", "unknown1"),
      await raw("ada+self@example.com", code),
      await raw("ada@example.com", code),
    ]

    expect(responses).toEqual(Array.from({ length: 4 }, () => JSON.stringify([200, { success: true }])))
  })

  it("ignores a self-referral, the +tag stripped by default", async () => {
    const { join, codeOf, entry } = await createReferralInstance()
    await join("ada@example.com")
    const code = await codeOf("ada@example.com")

    await join("ada+second@example.com", code)
    await join("ADA+third@Example.com", code)

    expect(await entry("ada+second@example.com")).toMatchObject({ status: "pending", referredById: null })
    expect(await entry("ada+third@example.com")).toMatchObject({ status: "pending", referredById: null })
  })

  it("gives onJoin the referrer, or null", async () => {
    const joins: OnJoinData[] = []
    const { join, codeOf } = await createReferralInstance({ onJoin: (data) => void joins.push(data) })
    await join("ada@example.com")

    await join("bob@example.com", await codeOf("ada@example.com"))
    await join("carol@example.com", "unknown1")

    expect(joins.map(({ entry, referrer }) => [entry.email, referrer?.email ?? null])).toEqual([
      ["ada@example.com", null],
      ["bob@example.com", "ada@example.com"],
      ["carol@example.com", null],
    ])
    expect(joins[1]?.referrer).not.toHaveProperty("inviteCodeHash")
  })

  it("never changes an existing entry's referrer on a repeat join", async () => {
    const { join, codeOf, entry } = await createReferralInstance()
    await join("ada@example.com")
    await join("bob@example.com")

    await join("bob@example.com", await codeOf("ada@example.com"))

    expect(await entry("bob@example.com")).toMatchObject({ referredById: null })
  })
})

describe("option: referral.enabled", () => {
  it("is on by default", async () => {
    const { join, codeOf, entry } = await createReferralInstance()
    await join("ada@example.com")

    await join("bob@example.com", await codeOf("ada@example.com"))

    expect((await entry("bob@example.com"))?.referredById).toEqual(expect.any(String))
  })

  it("false ignores referral codes on join and claims no success", async () => {
    const { join, codeOf, confirm, entry, successes, status } = await createReferralInstance({
      referral: { enabled: false },
    })
    await join("ada@example.com")

    expect(await join("bob@example.com", await codeOf("ada@example.com"))).toEqual({ success: true })
    await confirm("bob@example.com")

    expect(await entry("bob@example.com")).toMatchObject({ referredById: null, referralSucceeded: false })
    expect(successes).toEqual([])
    expect((await status("ada@example.com")).referralCount).toBe(0)
  })
})

describe("option: referral.successOn", () => {
  it('is "confirm" by default: the first confirm claims the success, later ones and the join do not', async () => {
    const { join, codeOf, confirm, successes, entry } = await createReferralInstance()
    await join("ada@example.com")
    await join("bob@example.com", await codeOf("ada@example.com"))
    expect(successes).toEqual([])

    await confirm("bob@example.com")
    await confirm("bob@example.com")
    await confirm("bob@example.com")

    expect(successes).toHaveLength(1)
    const [success] = successes
    expect(success?.referrer).toMatchObject({ email: "ada@example.com", status: "pending" })
    expect(success?.referred).toMatchObject({ email: "bob@example.com", emailConfirmed: true, referralSucceeded: true })
    expect(success?.referred.referralSucceededAt).toBeInstanceOf(Date)
    expect(success?.referralCount).toBe(1)
    expect(success?.referrer).not.toHaveProperty("inviteCodeHash")
    expect(success?.referred).not.toHaveProperty("inviteCodeHash")
    expect(await entry("bob@example.com")).toMatchObject({ referralSucceeded: true })
  })

  it('"confirm" claims nothing when the confirmed entry has no referrer', async () => {
    const { join, confirm, successes, entry } = await createReferralInstance()
    await join("bob@example.com")

    await confirm("bob@example.com")

    expect(successes).toEqual([])
    expect(await entry("bob@example.com")).toMatchObject({ emailConfirmed: true, referralSucceeded: false })
  })

  it('"register" claims on registration and not on confirm', async () => {
    const { join, codeOf, confirm, signUp, successes, status } = await createReferralInstance({
      referral: { successOn: "register" },
    })
    await join("ada@example.com")
    await join("bob@example.com", await codeOf("ada@example.com"))

    await confirm("bob@example.com")
    expect(successes).toEqual([])

    expect((await signUp("bob@example.com")).status).toBe(200)

    expect(successes).toHaveLength(1)
    expect(successes[0]).toMatchObject({
      referrer: { email: "ada@example.com" },
      referred: { email: "bob@example.com", status: "registered", referralSucceeded: true },
      referralCount: 1,
    })
    await confirm("bob@example.com")
    await status("bob@example.com")
    expect(successes).toHaveLength(1)
  })

  it('"confirm" claims at registration with the invite code, which proves the inbox, exactly once', async () => {
    const { join, codeOf, confirm, signUp, successes, status, entry } = await createReferralInstance()
    await join("ada@example.com")
    await join("bob@example.com", await codeOf("ada@example.com"))

    expect((await signUp("bob@example.com")).status).toBe(200)

    expect(await entry("bob@example.com")).toMatchObject({
      status: "registered",
      emailConfirmed: true,
      confirmedAt: expect.any(Date),
      referralSucceeded: true,
    })
    expect(successes).toHaveLength(1)
    expect(successes[0]).toMatchObject({ referred: { email: "bob@example.com" }, referralCount: 1 })
    await confirm("bob@example.com")
    await status("bob@example.com")
    expect(successes).toHaveLength(1)
  })

  it('"confirm" does not claim at a registration that proved nothing (no code, unverified email)', async () => {
    const { join, codeOf, api, successes, entry, ...instance } = await createReferralInstance({
      gate: { requireInviteCode: false },
    })
    await join("ada@example.com")
    await join("bob@example.com", await codeOf("ada@example.com"))
    await api.inviteToWaitlist({ body: { email: "bob@example.com" } })

    const res = await request(instance, "/sign-up/email", {
      body: { email: "bob@example.com", password: PASSWORD, name: "Bob" },
    })

    expect(res.status).toBe(200)
    expect(await entry("bob@example.com")).toMatchObject({
      status: "registered",
      emailConfirmed: false,
      referralSucceeded: false,
    })
    expect(successes).toEqual([])
  })

  it('"register" with no endpoint context fires at registration, with ctx null', async () => {
    const contexts: unknown[] = []
    const { join, codeOf, successes, status, auth, api } = await createReferralInstance({
      referral: { successOn: "register" },
      gate: { allowWithoutContext: true, requireInviteCode: false },
      onReferralSuccess: (data, ctx) => {
        contexts.push(ctx)
        successes.push(data)
      },
    })
    await join("ada@example.com")
    await join("bob@example.com", await codeOf("ada@example.com"))
    await api.inviteToWaitlist({ body: { email: "bob@example.com" } })

    await (
      await auth.$context
    ).internalAdapter.createUser({ email: "bob@example.com", name: "Bob" }, { method: "seed-script" })

    expect(contexts).toEqual([null])
    expect(successes[0]).toMatchObject({
      referred: { email: "bob@example.com", status: "registered" },
      referralCount: 1,
    })
    await status("bob@example.com")
    expect(successes).toHaveLength(1)
    expect((await status("ada@example.com")).referralCount).toBe(1)
  })
})

describe("referral success", () => {
  it("counts successful referrals in the payload and the status response, and never moves the referrer", async () => {
    const { join, codeOf, confirm, successes, status, entry } = await createReferralInstance()
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    await join("ada@example.com")
    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"))
    await join("zed@example.com")
    vi.useRealTimers()
    const code = await codeOf("ada@example.com")
    const before = await entry("ada@example.com")
    for (const email of ["bob@example.com", "carol@example.com", "dan@example.com"]) await join(email, code)

    await confirm("bob@example.com")
    await confirm("carol@example.com")

    expect(successes.map((success) => success.referralCount)).toEqual([1, 2])
    expect(await status("ada@example.com")).toMatchObject({ referralCount: 2, position: 1 })
    expect((await status("bob@example.com")).referralCount).toBe(0)
    expect(await entry("ada@example.com")).toMatchObject({
      queueScore: before?.queueScore,
      boostSeconds: 0,
      version: before?.version,
    })
  })

  it("still tracks a referrer that is no longer pending", async () => {
    const instance = await createReferralInstance()
    const { join, codeOf, confirm, signUp, successes, status } = instance
    await join("ada@example.com")
    const code = await codeOf("ada@example.com")
    expect((await signUp("ada@example.com")).status).toBe(200)

    await join("bob@example.com", code)
    await confirm("bob@example.com")

    expect(successes).toHaveLength(1)
    expect(successes[0]).toMatchObject({
      referrer: { email: "ada@example.com", status: "registered" },
      referralCount: 1,
    })
    expect(await status("ada@example.com")).toMatchObject({ status: "registered", referralCount: 1 })
  })

  it("schedules the callback when the count read after the claim fails, with the count from before plus one", async () => {
    const instance = await createReferralInstance()
    const { join, codeOf, mailbox, successes, entry, status, auth } = instance
    await join("ada@example.com")
    await join("bob@example.com", await codeOf("ada@example.com"))
    const failCountAfterClaim = await armAfterClaim(auth)

    const res = await request(instance, "/waitlist/confirm", { body: { token: mailbox.tokenFor("bob@example.com") } })

    expect([res.status, await res.json()]).toEqual([200, { success: true }])
    expect(failCountAfterClaim.fired()).toBe(true)
    expect(await entry("bob@example.com")).toMatchObject({ referralSucceeded: true })
    expect(successes).toHaveLength(1)
    expect(successes[0]).toMatchObject({ referrer: { email: "ada@example.com" }, referralCount: 1 })
    expect((await status("ada@example.com")).referralCount).toBe(1)
  })

  it("claims nothing when a read before the claim fails: confirm still answers 200, and the next one claims", async () => {
    const instance = await createReferralInstance()
    const { join, codeOf, mailbox, successes, entry, confirm, auth } = instance
    await join("ada@example.com")
    await join("bob@example.com", await codeOf("ada@example.com"))
    const failFirstCount = await armBeforeClaim(auth)

    const res = await request(instance, "/waitlist/confirm", { body: { token: mailbox.tokenFor("bob@example.com") } })

    expect([res.status, await res.json()]).toEqual([200, { success: true }])
    expect(failFirstCount.fired()).toBe(true)
    expect(await entry("bob@example.com")).toMatchObject({ emailConfirmed: true, referralSucceeded: false })
    expect(successes).toEqual([])

    await confirm("bob@example.com")

    expect(successes).toHaveLength(1)
  })

  it("is exactly once per entry, not per person: an erased entry joined again can succeed again", async () => {
    const { join, codeOf, confirm, successes, entry, api } = await createReferralInstance()
    await join("ada@example.com")
    const code = await codeOf("ada@example.com")
    await join("bob@example.com", code)
    await confirm("bob@example.com")
    const bob = await entry("bob@example.com")

    await api.deleteWaitlistEntry({ body: { entryId: bob?.id ?? "" } })
    await join("bob@example.com", code)
    await confirm("bob@example.com")

    expect(successes.map((success) => [success.referred.email, success.referralCount])).toEqual([
      ["bob@example.com", 1],
      ["bob@example.com", 1],
    ])
    expect(successes[0]?.referred.id).not.toBe(successes[1]?.referred.id)
  })

  it("lets the host reward the referrer with boostWaitlistEntry from inside the callback", async () => {
    let boosted: unknown = null
    const instance = await createReferralInstance({
      onReferralSuccess: async ({ referrer }) => {
        boosted = await instance.api.boostWaitlistEntry({ body: { entryId: referrer.id, seconds: 3600 } })
      },
    })
    const { join, codeOf, confirm, status } = instance
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    await join("first@example.com")
    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"))
    await join("ada@example.com")
    vi.useRealTimers()
    await join("bob@example.com", await codeOf("ada@example.com"))
    expect((await status("ada@example.com")).position).toBe(2)

    await confirm("bob@example.com")

    expect(boosted).toMatchObject({ entry: { email: "ada@example.com", boostSeconds: 3600 } })
    expect(await status("ada@example.com")).toMatchObject({ position: 1, referralCount: 1 })
  })

  defineReferralConcurrencyCases("sqlite")
})

describe("referrer erasure (sqlite)", () => {
  defineReferrerErasureCases("sqlite")
})

describe("referrer erasure (memory adapter, no foreign keys)", () => {
  defineReferrerErasureCases("memory")
})

describe("malformed referral codes (sqlite)", () => {
  defineMalformedCodeCases("sqlite")
})

describe("option: referral.canonicalizeEmail", () => {
  it("replaces the default +tag rule for self-referral detection", async () => {
    const { join, codeOf, entry } = await createReferralInstance({
      referral: {
        canonicalizeEmail: (email) => email.replace(/^([^@]*)@/, (_, local: string) => `${local.replaceAll(".", "")}@`),
      },
    })
    await join("ada@example.com")
    const code = await codeOf("ada@example.com")

    await join("a.d.a@example.com", code)
    await join("ada+tag@example.com", code)

    expect(await entry("a.d.a@example.com")).toMatchObject({ referredById: null })
    expect((await entry("ada+tag@example.com"))?.referredById).toBe((await entry("ada@example.com"))?.id)
  })

  it("is asked the same number of times whether the code is known, unknown or the joiner's own", async () => {
    const calls: string[] = []
    const { join, codeOf } = await createReferralInstance({
      referral: {
        canonicalizeEmail: (email) => {
          calls.push(email)
          return email.toLowerCase()
        },
      },
    })
    await join("ada@example.com")
    const code = await codeOf("ada@example.com")
    const callsFor = async (email: string, referralCode: string) => {
      calls.length = 0
      await join(email, referralCode)
      return calls.length
    }

    const counts = [
      await callsFor("bob@example.com", code),
      await callsFor("carol@example.com", "unknown1"),
      await callsFor("ada@example.com", code),
      await callsFor("dan@example.com", "short"),
    ]

    expect(counts).toEqual([2, 2, 2, 2])
  })

  it("counts a throw as a self-referral: the code is ignored, the join succeeds, the error is logged", async () => {
    const { lines, logger } = createLogger()
    const { join, codeOf, entry } = await createReferralInstance(
      {
        referral: {
          canonicalizeEmail: () => {
            throw new Error("canonicalize down")
          },
        },
      },
      { auth: { logger } }
    )
    await join("ada@example.com")

    expect(await join("bob@example.com", await codeOf("ada@example.com"))).toEqual({ success: true })

    expect(await entry("bob@example.com")).toMatchObject({ referredById: null })
    expect(lines.some((line) => line.level === "error" && line.message.includes("referral.canonicalizeEmail"))).toBe(
      true
    )
  })
})

describe("option: onReferralSuccess", () => {
  it("runs after the claim is written: the referrer's count already includes it", async () => {
    let seen: unknown = null
    const instance = await createReferralInstance({
      onReferralSuccess: async () => {
        seen = await instance.status("ada@example.com")
      },
    })
    const { join, codeOf, confirm } = instance
    await join("ada@example.com")
    await join("bob@example.com", await codeOf("ada@example.com"))

    await confirm("bob@example.com")

    expect(seen).toMatchObject({ referralCount: 1 })
  })

  it("is not retried after it throws, never changes the response, and logs no status token", async () => {
    const { lines, logger } = createLogger()
    let calls = 0
    const instance = await createReferralInstance(
      {
        onReferralSuccess: (data, ctx) => {
          calls++
          throw new Error(`reward failed for ${JSON.stringify([data, ctx?.body, ctx?.query])}`)
        },
      },
      { auth: { logger } }
    )
    const { join, codeOf, mailbox, entry } = instance
    await join("ada@example.com")
    await join("bob@example.com", await codeOf("ada@example.com"))
    const token = mailbox.tokenFor("bob@example.com")

    const first = await request(instance, "/waitlist/confirm", { body: { token } })
    const second = await request(instance, "/waitlist/confirm", { body: { token } })

    expect([first.status, await first.json()]).toEqual([200, { success: true }])
    expect([second.status, await second.json()]).toEqual([200, { success: true }])
    expect(calls).toBe(1)
    expect(await entry("bob@example.com")).toMatchObject({ referralSucceeded: true })
    const errors = lines.filter((line) => line.level === "error")
    expect(errors.some((line) => line.message.startsWith("[waitlist] onReferralSuccess callback failed"))).toBe(true)
    for (const line of errors) expect(line.message).not.toContain(token)
  })

  it("never changes the sign-up response when it throws on registration", async () => {
    const { lines, logger } = createLogger()
    const { join, codeOf, signUp, entry } = await createReferralInstance(
      {
        referral: { successOn: "register" },
        onReferralSuccess: () => {
          throw new Error("reward failed")
        },
      },
      { auth: { logger } }
    )
    await join("ada@example.com")
    await join("bob@example.com", await codeOf("ada@example.com"))

    const res = await signUp("bob@example.com")

    expect(res.status).toBe(200)
    expect(await entry("bob@example.com")).toMatchObject({ status: "registered", referralSucceeded: true })
    expect(lines.some((line) => line.level === "error" && line.message.includes("onReferralSuccess"))).toBe(true)
  })

  it("is scheduled through advanced.backgroundTasks when configured", async () => {
    const background = createBackgroundTasks()
    let release = () => {}
    const releasing = new Promise<void>((resolve) => {
      release = resolve
    })
    const rewarded: string[] = []
    const { join, codeOf, confirm } = await createReferralInstance(
      {
        onReferralSuccess: async ({ referrer }) => {
          await releasing
          rewarded.push(referrer.email)
        },
      },
      { auth: { advanced: background.advanced } }
    )
    await join("ada@example.com")
    await join("bob@example.com", await codeOf("ada@example.com"))

    expect(await confirm("bob@example.com")).toEqual({ success: true })
    expect(rewarded).toEqual([])

    release()
    await background.settle()
    expect(rewarded).toEqual(["ada@example.com"])
  })

  it("is optional: the success is still recorded and counted", async () => {
    const { join, codeOf, confirm, status, entry } = await createReferralInstance({ onReferralSuccess: undefined })
    await join("ada@example.com")
    await join("bob@example.com", await codeOf("ada@example.com"))

    await confirm("bob@example.com")

    expect(await entry("bob@example.com")).toMatchObject({ referralSucceeded: true })
    expect((await status("ada@example.com")).referralCount).toBe(1)
  })
})
