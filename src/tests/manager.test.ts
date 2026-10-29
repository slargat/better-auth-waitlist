import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { type OnJoinData, WAITLIST_ERROR_CODES, type WaitlistEntry, type WaitlistOptions } from "../index"
import {
  approveEntry,
  createMailbox,
  createWaitlistInstance,
  entryIdOf,
  rejectEntry,
  signInAs,
  signUpAdmitted,
} from "./harness"
import { createLogger } from "./logger"

afterEach(() => {
  vi.useRealTimers()
})

async function withEntries(emails: string[], options: WaitlistOptions = {}) {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
  const mailbox = createMailbox()
  const instance = await createWaitlistInstance({ ...mailbox.options, ...options })
  for (const email of emails) {
    await instance.auth.api.joinWaitlist({ body: { email } })
    vi.advanceTimersByTime(1000)
  }
  const { api } = instance.auth
  const idOf = (email: string) => entryIdOf(instance, email)
  const positionOf = async (email: string) =>
    (await api.getWaitlistStatus({ query: { token: mailbox.tokenFor(email) } })).position
  const entryOf = async (email: string): Promise<WaitlistEntry | undefined> =>
    (await api.listWaitlistEntries({ query: { search: email } })).entries[0]
  const confirm = (email: string) => api.confirmWaitlistEntry({ body: { token: mailbox.tokenFor(email) } })
  return { ...instance, api, mailbox, idOf, positionOf, entryOf, confirm }
}

const emailsOf = (entries: { email: string }[]) => entries.map((entry) => entry.email)

describe("listWaitlistEntries", () => {
  const emails = ["c@example.com", "a@example.com", "d@other.test", "b@example.com"]

  it("sorts by queue by default, ascending, with the total", async () => {
    const { api } = await withEntries(emails)

    const res = await api.listWaitlistEntries({ query: {} })

    expect(emailsOf(res.entries)).toEqual(emails)
    expect(res.total).toBe(4)
    expect(res.entries[0]).not.toHaveProperty("inviteCodeHash")
  })

  it("sorts by email or createdAt, in either direction", async () => {
    const { api } = await withEntries(emails)

    const byEmail = await api.listWaitlistEntries({ query: { sortBy: "email" } })
    const newestFirst = await api.listWaitlistEntries({ query: { sortBy: "createdAt", sortDirection: "desc" } })

    expect(emailsOf(byEmail.entries)).toEqual(["a@example.com", "b@example.com", "c@example.com", "d@other.test"])
    expect(emailsOf(newestFirst.entries)).toEqual([...emails].reverse())
  })

  it("filters by status, a case-insensitive email search, confirmation and referrer", async () => {
    const { api, confirm, idOf, ...instance } = await withEntries(emails)
    await rejectEntry({ auth: instance.auth }, "a@example.com")
    await confirm("b@example.com")

    const rejected = await api.listWaitlistEntries({ query: { status: "rejected" } })
    const search = await api.listWaitlistEntries({ query: { search: "EXAMPLE.com" } })
    const confirmed = await api.listWaitlistEntries({ query: { confirmed: true } })
    const unconfirmed = await api.listWaitlistEntries({ query: { confirmed: false } })
    const referred = await api.listWaitlistEntries({ query: { referredById: await idOf("a@example.com") } })

    expect(emailsOf(rejected.entries)).toEqual(["a@example.com"])
    expect(emailsOf(search.entries)).toEqual(["c@example.com", "a@example.com", "b@example.com"])
    expect(search.total).toBe(3)
    expect(emailsOf(confirmed.entries)).toEqual(["b@example.com"])
    expect(unconfirmed.total).toBe(3)
    expect(referred.total).toBe(0)
  })

  it("paginates with limit and offset", async () => {
    const { api } = await withEntries(emails)

    const page = await api.listWaitlistEntries({ query: { limit: 2, offset: 1 } })

    expect(emailsOf(page.entries)).toEqual(["a@example.com", "d@other.test"])
    expect(page.total).toBe(4)
  })

  it("coerces query-string numbers and booleans from a manager's HTTP request", async () => {
    const instance = await withEntries(emails)
    await instance.confirm("a@example.com")
    const { headers } = await signInAs(instance, "manager@example.com")

    const res = await instance.client.waitlist.admin.list(
      { query: { confirmed: "false", limit: "1", offset: "1" } },
      { headers }
    )
    const confirmed = await instance.client.waitlist.admin.list({ query: { confirmed: "true" } }, { headers })

    expect(res.error).toBeNull()
    expect(emailsOf(res.data?.entries ?? [])).toEqual(["d@other.test"])
    expect(res.data?.total).toBe(3)
    expect(emailsOf(confirmed.data?.entries ?? [])).toEqual(["a@example.com"])
  })

  it("includes position only for status=pending sorted by queue, unnarrowed", async () => {
    const { api, positionOf } = await withEntries(emails)
    await rejectEntry({ auth: { api } }, "a@example.com")

    const queue = await api.listWaitlistEntries({ query: { status: "pending", limit: 2, offset: 1 } })
    const reversed = await api.listWaitlistEntries({ query: { status: "pending", sortDirection: "desc" } })
    const all = await api.listWaitlistEntries({ query: {} })
    const byEmail = await api.listWaitlistEntries({ query: { status: "pending", sortBy: "email" } })
    const searched = await api.listWaitlistEntries({ query: { status: "pending", search: "example.com" } })

    expect(queue.entries.map((entry) => [entry.email, "position" in entry ? entry.position : undefined])).toEqual([
      ["d@other.test", 2],
      ["b@example.com", 3],
    ])
    for (const entry of queue.entries) {
      expect("position" in entry ? entry.position : undefined).toBe(await positionOf(entry.email))
    }
    expect(reversed.entries.map((entry) => ("position" in entry ? entry.position : undefined))).toEqual([3, 2, 1])
    for (const res of [all, byEmail, searched]) {
      for (const entry of res.entries) expect(entry).not.toHaveProperty("position")
    }
  })

  it("rejects a limit outside 1..100", async () => {
    const { api } = await withEntries([])

    await expect(api.listWaitlistEntries({ query: { limit: 101 } })).rejects.toMatchObject({ statusCode: 400 })
    await expect(api.listWaitlistEntries({ query: { limit: 0 } })).rejects.toMatchObject({ statusCode: 400 })
  })

  it("matches % and _ in a search literally, not as LIKE wildcards", async () => {
    const { api } = await withEntries(["a@x.com", "_@x.com", "ab@x.com", "a1b@x.com", "a_b@x.com"])

    const underscore = await api.listWaitlistEntries({ query: { search: "_@x.com" } })
    const inner = await api.listWaitlistEntries({ query: { search: "A_B", limit: 1 } })
    const percent = await api.listWaitlistEntries({ query: { search: "a%b" } })

    expect(emailsOf(underscore.entries)).toEqual(["_@x.com"])
    expect(underscore.total).toBe(1)
    expect(emailsOf(inner.entries)).toEqual(["a_b@x.com"])
    expect(inner.total).toBe(1)
    expect(percent.total).toBe(0)
  })
})

describe("bulk operations", () => {
  async function failWritesFor(instance: Awaited<ReturnType<typeof withEntries>>, entryId: string) {
    const { adapter } = await instance.auth.$context
    const incrementOne = adapter.incrementOne
    adapter.incrementOne = async (data) => {
      if (data.where.some((clause) => clause.field === "id" && clause.value === entryId)) {
        throw new Error("connection reset")
      }
      return incrementOne(data)
    }
  }

  it("reports a failed entry as error and still approves the others", async () => {
    const instance = await withEntries(["a@example.com", "b@example.com", "c@example.com"])
    const [a, b, c] = await Promise.all(["a@example.com", "b@example.com", "c@example.com"].map(instance.idOf))
    await failWritesFor(instance, b ?? "")

    const { results } = await instance.api.approveWaitlistEntries({ body: { entryIds: [a ?? "", b ?? "", c ?? ""] } })

    expect(results).toEqual([
      { entryId: a, outcome: "approved" },
      { entryId: b, outcome: "error" },
      { entryId: c, outcome: "approved" },
    ])
  })

  it("reports a failed entry as error and still rejects the others", async () => {
    const instance = await withEntries(["a@example.com", "b@example.com"])
    const [a, b] = await Promise.all(["a@example.com", "b@example.com"].map(instance.idOf))
    await failWritesFor(instance, a ?? "")

    const { results } = await instance.api.rejectWaitlistEntries({ body: { entryIds: [a ?? "", b ?? ""] } })

    expect(results).toEqual([
      { entryId: a, outcome: "error" },
      { entryId: b, outcome: "rejected" },
    ])
  })

  it("logs a failed entry without the invite it was writing", async () => {
    const { lines, logger } = createLogger()
    const instance = await createWaitlistInstance({}, { auth: { logger } })
    await instance.auth.api.joinWaitlist({ body: { email: "ada@example.com" } })
    const entryId = await entryIdOf(instance, "ada@example.com")
    const { adapter } = await instance.auth.$context
    const hashes: string[] = []
    adapter.incrementOne = async (data) => {
      const hash = String(data.set?.inviteCodeHash)
      hashes.push(hash)
      throw new Error(`duplicate key value (invite_code_hash)=(${hash})`)
    }

    const { results } = await instance.auth.api.approveWaitlistEntries({ body: { entryIds: [entryId] } })

    expect(results).toEqual([{ entryId, outcome: "error" }])
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/)
    const errors = lines.filter((line) => line.level === "error")
    expect(errors.map((line) => line.message)).toEqual([
      "[waitlist] approve failed for one entry: Error: duplicate key value (invite_code_hash)=([redacted])",
    ])
  })
})

describe("getWaitlistStats", () => {
  it("counts entries by status, confirmation, expired invites and successful referrals", async () => {
    const { api, confirm } = await withEntries(["p1@example.com", "p2@example.com", "a1@example.com", "a2@example.com"])
    await confirm("p1@example.com")
    await approveEntry({ auth: { api } }, "a1@example.com")
    vi.advanceTimersByTime(8 * 24 * 3600 * 1000)
    await approveEntry({ auth: { api } }, "a2@example.com")
    await api.joinWaitlist({ body: { email: "r@example.com" } })
    await rejectEntry({ auth: { api } }, "r@example.com")

    expect(await api.getWaitlistStats({})).toEqual({
      pending: 2,
      pendingConfirmed: 1,
      approved: 2,
      approvedExpired: 1,
      rejected: 1,
      registered: 0,
      successfulReferrals: 0,
      total: 5,
    })
  })

  it("counts registered entries", async () => {
    const instance = await withEntries(["ada@example.com"], { invite: { returnCodeToManager: true } })
    const { api } = instance
    await signUpAdmitted(instance, "ada@example.com")

    expect(await api.getWaitlistStats({})).toMatchObject({ pending: 0, registered: 1, total: 1 })
  })
})

describe("approveWaitlistEntries", () => {
  it("approves by id with a fresh invite, and reports each outcome", async () => {
    const { api, idOf, entryOf } = await withEntries(["a@example.com", "b@example.com"])
    const [a, b] = [await idOf("a@example.com"), await idOf("b@example.com")]
    await api.approveWaitlistEntries({ body: { entryIds: [b] } })

    const { results } = await api.approveWaitlistEntries({ body: { entryIds: [a, b, "missing"] } })

    expect(results).toEqual([
      { entryId: a, outcome: "approved" },
      { entryId: b, outcome: "skipped" },
      { entryId: "missing", outcome: "not_found" },
    ])
    expect(results[0]).not.toHaveProperty("code")
    expect(await entryOf("a@example.com")).toMatchObject({
      status: "approved",
      invitedAt: new Date("2026-01-01T00:00:02Z"),
      inviteExpiresAt: new Date("2026-01-08T00:00:02Z"),
    })
  })

  it("reports invalid_transition for an entry that can't be approved", async () => {
    const instance = await withEntries(["ada@example.com"], { invite: { returnCodeToManager: true } })
    const { api, idOf } = instance
    await signUpAdmitted(instance, "ada@example.com")
    const id = await idOf("ada@example.com")

    const { results } = await api.approveWaitlistEntries({ body: { entryIds: [id] } })

    expect(results).toEqual([{ entryId: id, outcome: "invalid_transition" }])
  })

  it("approves the next N confirmed entries in queue order by default", async () => {
    const { api, confirm, entryOf, idOf } = await withEntries([
      "a@example.com",
      "b@example.com",
      "c@example.com",
      "d@example.com",
    ])
    for (const email of ["b@example.com", "c@example.com", "d@example.com"]) await confirm(email)

    const { results } = await api.approveWaitlistEntries({ body: { next: 2 } })

    expect(results).toEqual([
      { entryId: await idOf("b@example.com"), outcome: "approved" },
      { entryId: await idOf("c@example.com"), outcome: "approved" },
    ])
    expect((await entryOf("a@example.com"))?.status).toBe("pending")
  })

  it("includes unconfirmed entries with confirmedOnly: false", async () => {
    const { api, idOf } = await withEntries(["a@example.com", "b@example.com"])

    const { results } = await api.approveWaitlistEntries({ body: { next: 5, confirmedOnly: false } })

    expect(results.map((result) => result.entryId)).toEqual([await idOf("a@example.com"), await idOf("b@example.com")])
  })

  it("validates the body: 1..100 ids, or next in 1..100", async () => {
    const { api } = await withEntries([])
    const tooMany = Array.from({ length: 101 }, (_, i) => `id${i}`)

    for (const body of [{ entryIds: [] }, { entryIds: tooMany }, { next: 0 }, { next: 101 }]) {
      await expect(api.approveWaitlistEntries({ body })).rejects.toMatchObject({ statusCode: 400 })
    }
  })
})

describe("rejectWaitlistEntries", () => {
  it("rejects with a reason that managers see and the public status never shows, clearing the invite", async () => {
    const { api, idOf, entryOf, mailbox } = await withEntries(["ada@example.com"])
    const id = await idOf("ada@example.com")
    await api.approveWaitlistEntries({ body: { entryIds: [id] } })

    const { results } = await api.rejectWaitlistEntries({ body: { entryIds: [id], reason: "Spam signups" } })

    expect(results).toEqual([{ entryId: id, outcome: "rejected" }])
    expect(await entryOf("ada@example.com")).toMatchObject({
      status: "rejected",
      rejectionReason: "Spam signups",
      inviteExpiresAt: null,
    })
    const status = await api.getWaitlistStatus({ query: { token: mailbox.tokenFor("ada@example.com") } })
    expect(status).not.toHaveProperty("rejectionReason")
    expect(JSON.stringify(status)).not.toContain("Spam")
    expect(status.invite).toBeNull()
  })

  it("rejects a reason over 500 characters", async () => {
    const { api, idOf } = await withEntries(["ada@example.com"])
    const id = await idOf("ada@example.com")

    await expect(
      api.rejectWaitlistEntries({ body: { entryIds: [id], reason: "x".repeat(501) } })
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe("requeueWaitlistEntry", () => {
  it("puts the entry back at its original place and clears the invite", async () => {
    const { api, idOf, positionOf, entryOf } = await withEntries(["a@example.com", "b@example.com", "c@example.com"])
    const id = await idOf("a@example.com")
    await api.approveWaitlistEntries({ body: { entryIds: [id] } })
    expect(await positionOf("b@example.com")).toBe(1)

    const { entry } = await api.requeueWaitlistEntry({ body: { entryId: id } })

    expect(entry.status).toBe("pending")
    expect(entry.queueScore).toBe(new Date("2026-01-01T00:00:00Z").getTime())
    expect(await positionOf("a@example.com")).toBe(1)
    expect(await positionOf("b@example.com")).toBe(2)
    expect((await entryOf("a@example.com"))?.inviteExpiresAt).toBeNull()
  })
})

describe("resendWaitlistInvite", () => {
  it("issues a new code and resets the expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    const instance = await createWaitlistInstance({ invite: { returnCodeToManager: true } })
    const { api } = instance.auth
    await api.joinWaitlist({ body: { email: "ada@example.com" } })
    const id = await entryIdOf(instance, "ada@example.com")
    const approved = await api.approveWaitlistEntries({ body: { entryIds: [id] } })
    vi.advanceTimersByTime(3 * 24 * 3600 * 1000)

    const resent = await api.resendWaitlistInvite({ body: { entryId: id } })

    expect(resent.entry).toMatchObject({
      status: "approved",
      invitedAt: new Date("2026-01-04T00:00:00Z"),
      inviteExpiresAt: new Date("2026-01-11T00:00:00Z"),
    })
    expect(resent.entry).not.toHaveProperty("inviteCodeHash")
    expect(resent.code).toMatch(/^[A-Za-z0-9]{24}$/)
    expect(resent.code).not.toBe(approved.results[0]?.code)
  })
})

describe("inviteToWaitlist", () => {
  it("creates an approved entry with an invite for an unknown email, and fires onJoin with source manager", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    const joins: OnJoinData[] = []
    const { auth } = await createWaitlistInstance({ onJoin: (data) => void joins.push(data) })

    const { entry } = await auth.api.inviteToWaitlist({ body: { email: "VIP@Example.com", name: "Vip" } })

    expect(entry).toMatchObject({
      email: "vip@example.com",
      name: "Vip",
      status: "approved",
      inviteExpiresAt: new Date("2026-01-08T00:00:00Z"),
    })
    expect(entry.referralCode).toMatch(/^[a-z0-9]{8}$/)
    expect(entry).not.toHaveProperty("code")
    expect(joins.map((join) => [join.source, join.entry.email])).toEqual([["manager", "vip@example.com"]])
  })

  it("approves an existing pending entry without creating another", async () => {
    const { api, entryOf } = await withEntries(["ada@example.com"])

    const { entry } = await api.inviteToWaitlist({ body: { email: "ada@example.com", name: "Renamed" } })

    expect(entry.status).toBe("approved")
    expect((await api.listWaitlistEntries({ query: {} })).total).toBe(1)
    expect((await entryOf("ada@example.com"))?.name).toBeNull()
  })
})

describe("boostWaitlistEntry", () => {
  it("moves the entry up the queue, and a negative boost undoes it", async () => {
    const { api, idOf, positionOf } = await withEntries(["a@example.com", "b@example.com", "c@example.com"])
    const c = await idOf("c@example.com")

    const { entry } = await api.boostWaitlistEntry({ body: { entryId: c, seconds: 3 } })

    expect(entry.boostSeconds).toBe(3)
    expect(entry.queueScore).toBe(new Date("2026-01-01T00:00:02Z").getTime() - 3000)
    expect(await positionOf("c@example.com")).toBe(1)
    expect(await positionOf("a@example.com")).toBe(2)

    await api.boostWaitlistEntry({ body: { entryId: c, seconds: -3 } })
    expect(await positionOf("c@example.com")).toBe(3)
  })

  it("returns ENTRY_NOT_FOUND for a missing entry and rejects a fractional number of seconds", async () => {
    const { api, idOf } = await withEntries(["ada@example.com"])

    await expect(api.boostWaitlistEntry({ body: { entryId: "missing", seconds: 1 } })).rejects.toMatchObject({
      statusCode: 404,
      body: { code: WAITLIST_ERROR_CODES.ENTRY_NOT_FOUND.code },
    })
    await expect(
      api.boostWaitlistEntry({ body: { entryId: await idOf("ada@example.com"), seconds: 1.5 } })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it("accepts at most 10 years either way", async () => {
    const { api, idOf } = await withEntries(["ada@example.com"])
    const entryId = await idOf("ada@example.com")
    const tenYears = 10 * 365 * 24 * 3600

    expect((await api.boostWaitlistEntry({ body: { entryId, seconds: tenYears } })).entry.boostSeconds).toBe(tenYears)
    expect((await api.boostWaitlistEntry({ body: { entryId, seconds: -tenYears } })).entry.boostSeconds).toBe(0)
    for (const seconds of [tenYears + 1, -tenYears - 1]) {
      await expect(api.boostWaitlistEntry({ body: { entryId, seconds } })).rejects.toMatchObject({ statusCode: 400 })
    }
  })

  it("boosts only pending entries: INVALID_STATUS_TRANSITION otherwise, with nothing written", async () => {
    const { api, idOf, entryOf } = await withEntries(["ada@example.com"])
    const entryId = await idOf("ada@example.com")
    await api.approveWaitlistEntries({ body: { entryIds: [entryId] } })
    const before = await entryOf("ada@example.com")

    await expect(api.boostWaitlistEntry({ body: { entryId, seconds: 60 } })).rejects.toMatchObject({
      statusCode: 409,
      body: { code: WAITLIST_ERROR_CODES.INVALID_STATUS_TRANSITION.code },
    })
    expect(await entryOf("ada@example.com")).toEqual(before)
  })
})

describe("deleteWaitlistEntry", () => {
  it("removes the entry, after which its status link stops working", async () => {
    const { api, client, idOf, mailbox } = await withEntries(["ada@example.com"])
    const id = await idOf("ada@example.com")

    expect(await api.deleteWaitlistEntry({ body: { entryId: id } })).toEqual({ success: true })

    expect((await api.listWaitlistEntries({ query: {} })).total).toBe(0)
    const status = await client.waitlist.status({ query: { token: mailbox.tokenFor("ada@example.com") } })
    expect(status.error?.code).toBe(WAITLIST_ERROR_CODES.INVALID_STATUS_TOKEN.code)
    await expect(api.deleteWaitlistEntry({ body: { entryId: id } })).rejects.toMatchObject({ statusCode: 404 })
  })
})
