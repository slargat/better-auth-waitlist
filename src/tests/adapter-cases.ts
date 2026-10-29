import { expect, it, vi } from "vite-plus/test"
import type { OnStatusChangeData } from "../index"
import { createMailbox, createWaitlistInstance, entryIdOf } from "./harness"

const EMAIL = "ada@example.com"

export function defineConcurrencyCases(testWith: "sqlite" | "postgres") {
  async function setup() {
    const changes: OnStatusChangeData[] = []
    const instance = await createWaitlistInstance({ onStatusChange: (data) => void changes.push(data) }, { testWith })
    await instance.auth.api.joinWaitlist({ body: { email: EMAIL } })
    const entryId = await entryIdOf(instance, EMAIL)
    const entry = async () => (await instance.auth.api.listWaitlistEntries({ query: { search: EMAIL } })).entries[0]
    const interleave = async (between: () => Promise<void>, times = 1) => {
      const { adapter } = await instance.auth.$context
      const incrementOne = adapter.incrementOne
      let fired = 0
      let inside = false
      adapter.incrementOne = async (data) => {
        if (fired < times && !inside) {
          fired++
          inside = true
          await between()
          inside = false
        }
        return incrementOne(data)
      }
    }
    return { ...instance, api: instance.auth.api, changes, entryId, entry, interleave }
  }

  it("approves an entry once under 20 concurrent approvals: one invite, one status change", async () => {
    const { api, changes, entryId, entry } = await setup()
    changes.length = 0

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => api.approveWaitlistEntries({ body: { entryIds: [entryId] } }))
    )

    const outcomes = responses.map((res) => res.results[0]?.outcome)
    expect(outcomes.filter((outcome) => outcome === "approved")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === "skipped")).toHaveLength(19)
    expect(changes.map((change) => change.event)).toEqual(["approve"])
    expect(await entry()).toMatchObject({ status: "approved", version: 1 })
  })

  it("rotates the invite once when two resends race: the one that loses is skipped", async () => {
    const { api, changes, entryId, entry, interleave } = await setup()
    await api.approveWaitlistEntries({ body: { entryIds: [entryId] } })
    changes.length = 0
    await interleave(async () => {
      await api.resendWaitlistInvite({ body: { entryId } })
    })

    await api.resendWaitlistInvite({ body: { entryId } })

    expect(changes.map((change) => change.event)).toEqual(["resendInvite"])
    expect(await entry()).toMatchObject({ status: "approved", version: 2 })
  })

  it("rotates the invite on every one of sequential resends", async () => {
    const { api, changes, entryId, entry } = await setup()
    await api.approveWaitlistEntries({ body: { entryIds: [entryId] } })
    changes.length = 0

    for (let i = 0; i < 3; i++) await api.resendWaitlistInvite({ body: { entryId } })

    expect(changes.map((change) => change.event)).toEqual(["resendInvite", "resendInvite", "resendInvite"])
    expect(await entry()).toMatchObject({ version: 4 })
  })

  it("approves once when the entry went pending → approved → pending between the read and the write", async () => {
    const { api, changes, entryId, entry, interleave } = await setup()
    changes.length = 0
    await interleave(async () => {
      await api.approveWaitlistEntries({ body: { entryIds: [entryId] } })
      await api.requeueWaitlistEntry({ body: { entryId } })
    })

    const { results } = await api.approveWaitlistEntries({ body: { entryIds: [entryId] } })

    expect(results).toEqual([{ entryId, outcome: "approved" }])
    expect(changes.map((change) => [change.event, change.from, change.to])).toEqual([
      ["approve", "pending", "approved"],
      ["requeue", "approved", "pending"],
      ["approve", "pending", "approved"],
    ])
    expect(await entry()).toMatchObject({ status: "approved", version: 3 })
  })

  it("skips a resend when the entry went approved → pending → approved between the read and the write", async () => {
    const { api, changes, entryId, entry, interleave } = await setup()
    await api.approveWaitlistEntries({ body: { entryIds: [entryId] } })
    changes.length = 0
    await interleave(async () => {
      await api.requeueWaitlistEntry({ body: { entryId } })
      await api.approveWaitlistEntries({ body: { entryIds: [entryId] } })
    })

    await api.resendWaitlistInvite({ body: { entryId } })

    expect(changes.map((change) => change.event)).toEqual(["requeue", "approve"])
    expect(await entry()).toMatchObject({ status: "approved", version: 3 })
  })

  it("still applies a transition that raced a non-status write (a boost)", async () => {
    const { api, changes, entryId, entry, interleave } = await setup()
    changes.length = 0
    await interleave(async () => {
      await api.boostWaitlistEntry({ body: { entryId, seconds: 60 } })
    })

    const { results } = await api.approveWaitlistEntries({ body: { entryIds: [entryId] } })

    expect(results).toEqual([{ entryId, outcome: "approved" }])
    expect(changes.map((change) => change.event)).toEqual(["approve"])
    expect(await entry()).toMatchObject({ status: "approved", boostSeconds: 60, version: 2 })
  })

  it.each([
    ["reject", "rejected"],
    ["requeue", "pending"],
  ] as const)("refuses a resend that lost to a %s (409), with no invite sent", async (event, status) => {
    const { api, changes, entryId, entry, interleave } = await setup()
    await api.approveWaitlistEntries({ body: { entryIds: [entryId] } })
    changes.length = 0
    await interleave(async () => {
      if (event === "reject") await api.rejectWaitlistEntries({ body: { entryIds: [entryId] } })
      else await api.requeueWaitlistEntry({ body: { entryId } })
    })

    await expect(api.resendWaitlistInvite({ body: { entryId } })).rejects.toMatchObject({
      statusCode: 409,
      body: { code: "INVALID_STATUS_TRANSITION" },
    })
    expect(changes.map((change) => change.event)).toEqual([event])
    expect((await entry())?.status).toBe(status)
  })

  it("still applies after several non-status writes in its window (3 boosts)", async () => {
    const { api, changes, entryId, entry, interleave } = await setup()
    changes.length = 0
    await interleave(async () => {
      await api.boostWaitlistEntry({ body: { entryId, seconds: 1 } })
    }, 3)

    const { results } = await api.approveWaitlistEntries({ body: { entryIds: [entryId] } })

    expect(results).toEqual([{ entryId, outcome: "approved" }])
    expect(changes.map((change) => change.event)).toEqual(["approve"])
    expect(await entry()).toMatchObject({ status: "approved", boostSeconds: 3, version: 4 })
  })

  it("gives up with invalid_transition after 20 lost writes, so contention can't loop forever", async () => {
    const { api, changes, entryId, entry, interleave } = await setup()
    changes.length = 0
    await interleave(async () => {
      await api.boostWaitlistEntry({ body: { entryId, seconds: 1 } })
    }, 25)

    const { results } = await api.approveWaitlistEntries({ body: { entryIds: [entryId] } })

    expect(results).toEqual([{ entryId, outcome: "invalid_transition" }])
    expect(changes).toEqual([])
    expect(await entry()).toMatchObject({ status: "pending", boostSeconds: 20 })
  })

  it("applies every one of 20 concurrent boosts", async () => {
    const { api, entryId, entry } = await setup()
    const before = await entry()

    await Promise.all(Array.from({ length: 20 }, () => api.boostWaitlistEntry({ body: { entryId, seconds: 60 } })))

    const after = await entry()
    expect(after?.boostSeconds).toBe(1200)
    expect(after?.queueScore).toBe((before?.queueScore ?? 0) - 1_200_000)
  })
}

const TIED = ["t1@example.com", "t2@example.com", "t3@example.com", "t4@example.com", "t5@example.com"]

export function defineOrderingCases(testWith: "sqlite" | "postgres") {
  async function tiedQueue() {
    const mailbox = createMailbox()
    const instance = await createWaitlistInstance({ ...mailbox.options }, { testWith })
    const { api } = instance.auth
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    await api.joinWaitlist({ body: { email: "first@example.com" } })
    vi.advanceTimersByTime(1000)
    for (const email of TIED) await api.joinWaitlist({ body: { email } })
    vi.advanceTimersByTime(1000)
    await api.joinWaitlist({ body: { email: "last@example.com" } })
    vi.useRealTimers()
    const emails = ["first@example.com", ...TIED, "last@example.com"]
    const ranked = await Promise.all(
      emails.map(async (email) => {
        const status = await api.getWaitlistStatus({ query: { token: mailbox.tokenFor(email) } })
        return { email, position: status.position ?? 0 }
      })
    )
    const queue = ranked.sort((a, b) => a.position - b.position).map(({ email }) => email)
    return { ...instance, api, queue }
  }

  it("pages the list in status-position order across tied entries, both directions", async () => {
    const { api, queue } = await tiedQueue()
    expect([queue[0], queue.at(-1)]).toEqual(["first@example.com", "last@example.com"])

    const pages = async (sortDirection: "asc" | "desc") => {
      const all = await Promise.all(
        [0, 2, 4, 6].map((offset) =>
          api.listWaitlistEntries({ query: { status: "pending", limit: 2, offset, sortDirection } })
        )
      )
      return all.flatMap((res) => res.entries.map((entry) => [entry.email, "position" in entry ? entry.position : 0]))
    }

    expect(await pages("asc")).toEqual(queue.map((email, i) => [email, i + 1]))
    expect(await pages("desc")).toEqual(queue.map((email, i) => [email, i + 1]).reverse())
  })

  it("approves the next N in status-position order across tied entries", async () => {
    const { api, queue } = await tiedQueue()

    const { results } = await api.approveWaitlistEntries({ body: { next: 4, confirmedOnly: false } })

    const ids = await Promise.all(queue.slice(0, 4).map((email) => entryIdOf({ auth: { api } }, email)))
    expect(results.map((result) => result.entryId)).toEqual(ids)
  })

  it("serves a consistent page when an entry is boosted ahead of it mid-read", async () => {
    const { api, queue, ...instance } = await tiedQueue()
    const lastId = await entryIdOf({ auth: { api } }, "last@example.com")
    const { adapter } = await instance.auth.$context
    const count = adapter.count
    let raced = false
    adapter.count = async (data) => {
      if (!raced && data.where?.some((clause) => clause.field === "queueScore" && clause.operator === "lt")) {
        raced = true
        await api.boostWaitlistEntry({ body: { entryId: lastId, seconds: 3600 } })
      }
      return count(data)
    }

    const res = await api.listWaitlistEntries({ query: { status: "pending", limit: 3, offset: 1 } })

    expect(raced).toBe(true)
    const before = queue.slice(1, 4)
    const after = ["last@example.com", ...queue.slice(0, -1)].slice(1, 4)
    expect([before, after]).toContainEqual(res.entries.map((entry) => entry.email))
  })
}
