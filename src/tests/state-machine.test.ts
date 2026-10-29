import { APIError } from "better-auth/api"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { type OnStatusChangeData, WAITLIST_ERROR_CODES, type WaitlistOptions, type WaitlistStatus } from "../index"
import { defineConcurrencyCases, defineOrderingCases } from "./adapter-cases"
import {
  approveEntry,
  createWaitlistInstance,
  entryIdOf,
  failRegisterWrites,
  rejectEntry,
  signUpAdmitted,
} from "./harness"

afterEach(() => {
  vi.useRealTimers()
})

type FullInstance = Awaited<ReturnType<typeof createWaitlistInstance>>
interface Instance {
  auth: {
    api: Pick<
      FullInstance["auth"]["api"],
      | "joinWaitlist"
      | "listWaitlistEntries"
      | "approveWaitlistEntries"
      | "rejectWaitlistEntries"
      | "requeueWaitlistEntry"
      | "resendWaitlistInvite"
      | "inviteToWaitlist"
    >
  }
  client: { signUp: Pick<FullInstance["client"]["signUp"], "email"> }
  database: unknown
}
type FromState = WaitlistStatus | "none" | "claimed"
type ManagerEvent = "approve" | "directInvite" | "resendInvite" | "reject" | "requeue"
type Result = WaitlistStatus | "skipped" | "409" | "404"

const EMAIL = "ada@example.com"

const EXPECTED: Record<ManagerEvent, Record<FromState, Result>> = {
  approve: {
    none: "404",
    pending: "approved",
    approved: "skipped",
    rejected: "approved",
    registered: "409",
    claimed: "skipped",
  },
  directInvite: {
    none: "approved",
    pending: "approved",
    approved: "409",
    rejected: "approved",
    registered: "409",
    claimed: "409",
  },
  resendInvite: {
    none: "404",
    pending: "409",
    approved: "approved",
    rejected: "409",
    registered: "409",
    claimed: "409",
  },
  reject: {
    none: "404",
    pending: "rejected",
    approved: "rejected",
    rejected: "skipped",
    registered: "409",
    claimed: "409",
  },
  requeue: {
    none: "404",
    pending: "skipped",
    approved: "pending",
    rejected: "pending",
    registered: "409",
    claimed: "409",
  },
}

const EVENTS: ManagerEvent[] = ["approve", "directInvite", "resendInvite", "reject", "requeue"]
const FROMS: FromState[] = ["none", "pending", "approved", "rejected", "registered", "claimed"]
const CASES = EVENTS.flatMap((event) => FROMS.map((from) => ({ event, from, result: EXPECTED[event][from] })))

async function arrange(instance: Instance, from: FromState) {
  if (from === "none") return "missing-entry-id"
  await instance.auth.api.joinWaitlist({ body: { email: EMAIL } })
  if (from === "approved") await approveEntry(instance, EMAIL)
  if (from === "rejected") await rejectEntry(instance, EMAIL)
  if (from === "registered") await signUpAdmitted(instance, EMAIL)
  if (from === "claimed") {
    const restore = await failRegisterWrites(instance)
    await signUpAdmitted(instance, EMAIL)
    await restore()
  }
  return entryIdOf(instance, EMAIL)
}

async function fire(instance: Instance, event: ManagerEvent, entryId: string): Promise<Result> {
  const { api } = instance.auth
  const bulk = async (outcome: string) => {
    if (outcome === "not_found") return "404"
    if (outcome === "invalid_transition") return "409"
    if (outcome === "skipped") return "skipped"
    return statusOf(instance)
  }
  try {
    switch (event) {
      case "approve":
        return bulk((await api.approveWaitlistEntries({ body: { entryIds: [entryId] } })).results[0]?.outcome ?? "")
      case "reject":
        return bulk((await api.rejectWaitlistEntries({ body: { entryIds: [entryId] } })).results[0]?.outcome ?? "")
      case "requeue": {
        const before = await versionOf(instance)
        const { entry } = await api.requeueWaitlistEntry({ body: { entryId } })
        return entry.version === before ? "skipped" : entry.status
      }
      case "resendInvite":
        return (await api.resendWaitlistInvite({ body: { entryId } })).entry.status
      case "directInvite":
        return (await api.inviteToWaitlist({ body: { email: EMAIL } })).entry.status
    }
  } catch (error) {
    if (error instanceof APIError && (error.statusCode === 404 || error.statusCode === 409)) {
      const expected =
        error.statusCode === 404 ? WAITLIST_ERROR_CODES.ENTRY_NOT_FOUND : WAITLIST_ERROR_CODES.INVALID_STATUS_TRANSITION
      expect(error.body?.code).toBe(expected.code)
      return error.statusCode === 404 ? "404" : "409"
    }
    throw error
  }
}

async function entryOf(instance: Instance) {
  const { entries } = await instance.auth.api.listWaitlistEntries({ query: { search: EMAIL } })
  return entries[0] ?? null
}
const statusOf = async (instance: Instance) => (await entryOf(instance))?.status ?? "404"
const versionOf = async (instance: Instance) => (await entryOf(instance))?.version ?? -1

describe("state machine", () => {
  it.each(CASES)("$event from $from: $result", async ({ event, from, result }) => {
    const changes: OnStatusChangeData[] = []
    const instance = await createWaitlistInstance({
      onStatusChange: (data) => void changes.push(data),
      invite: { returnCodeToManager: true },
    })
    const entryId = await arrange(instance, from)
    const before = await entryOf(instance)
    changes.length = 0

    expect(await fire(instance, event, entryId)).toBe(result)

    const after = await entryOf(instance)
    if (result === "skipped" || result === "409") {
      expect(after).toEqual(before)
      expect(changes).toEqual([])
    } else if (result === "404") {
      expect(after).toBeNull()
      expect(changes).toEqual([])
    } else {
      expect(after?.status).toBe(result)
      expect(changes.map((change) => [change.event, change.from, change.to])).toEqual([
        [event, from === "none" ? null : from, result],
      ])
    }
  })
})

describe("idempotent retries", () => {
  it("re-approving an approved entry is skipped and issues no new invite", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    const instance = await createWaitlistInstance({})
    await instance.auth.api.joinWaitlist({ body: { email: EMAIL } })
    const entryId = await entryIdOf(instance, EMAIL)
    const first = await instance.auth.api.approveWaitlistEntries({ body: { entryIds: [entryId] } })
    const approved = await entryOf(instance)

    vi.advanceTimersByTime(60_000)
    const retry = await instance.auth.api.approveWaitlistEntries({ body: { entryIds: [entryId, entryId] } })

    expect(first.results).toEqual([{ entryId, outcome: "approved" }])
    expect(retry.results).toEqual([
      { entryId, outcome: "skipped" },
      { entryId, outcome: "skipped" },
    ])
    const after = await entryOf(instance)
    expect(after).toEqual(approved)
    expect(after?.invitedAt).toEqual(new Date("2026-01-01T00:00:00Z"))
  })
})

describe("option: onStatusChange", () => {
  it("fires after the write, with the entry, from, to, event and actor", async () => {
    const changes: OnStatusChangeData[] = []
    const seenInCallback: (string | undefined)[] = []
    const instance = await createWaitlistInstance({
      onStatusChange: async (data) => {
        changes.push(data)
        seenInCallback.push(await statusOf(instance))
      },
    })

    await instance.auth.api.joinWaitlist({ body: { email: EMAIL } })
    await approveEntry(instance, EMAIL)

    expect(changes.map(({ event, from, to, actorUserId }) => ({ event, from, to, actorUserId }))).toEqual([
      { event: "join", from: null, to: "pending", actorUserId: null },
      { event: "approve", from: "pending", to: "approved", actorUserId: null },
    ])
    expect(changes[1]?.entry).toMatchObject({ email: EMAIL, status: "approved" })
    expect(changes[1]?.entry).not.toHaveProperty("inviteCodeHash")
    expect(seenInCallback).toEqual(["pending", "approved"])
  })

  it("does not change the response when it throws", async () => {
    const options = {
      onStatusChange: () => {
        throw new Error("boom")
      },
    } satisfies WaitlistOptions
    const instance = await createWaitlistInstance(options)
    await instance.auth.api.joinWaitlist({ body: { email: EMAIL } })

    const { results } = await instance.auth.api.approveWaitlistEntries({
      body: { entryIds: [await entryIdOf(instance, EMAIL)] },
    })

    expect(results[0]?.outcome).toBe("approved")
  })
})

describe("guarded writes (sqlite)", () => {
  defineConcurrencyCases("sqlite")
})

describe("queue order (sqlite)", () => {
  defineOrderingCases("sqlite")
})
