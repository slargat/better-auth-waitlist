import { DatabaseSync } from "node:sqlite"
import { memoryAdapter } from "better-auth/adapters/memory"
import { getMigrations } from "better-auth/db/migration"
import { describe, expect, it, vi } from "vite-plus/test"
import { type WaitlistEntry, waitlist, waitlistSnakeCaseSchema } from "../index"
import { createMailbox, createWaitlistInstance } from "./harness"

const EXPECTED_FIELDS = [
  "email",
  "name",
  "status",
  "queueScore",
  "boostSeconds",
  "referralCode",
  "referredById",
  "referralSucceeded",
  "referralSucceededAt",
  "emailConfirmed",
  "confirmedAt",
  "inviteCodeHash",
  "inviteExpiresAt",
  "invitedAt",
  "userId",
  "decidedById",
  "decidedAt",
  "rejectionReason",
  "registeredAt",
  "lastNotifiedAt",
  "version",
  "createdAt",
  "updatedAt",
]

const compileSql = async (plugin: ReturnType<typeof waitlist>) => {
  const { compileMigrations } = await getMigrations({
    database: new DatabaseSync(":memory:"),
    plugins: [plugin],
  })
  return compileMigrations()
}

describe("schema", () => {
  it("declares exactly the documented entry fields", () => {
    const { fields } = waitlist().schema.waitlistEntry

    expect(Object.keys(fields).sort()).toEqual([...EXPECTED_FIELDS].sort())
  })

  it("declares the required field attributes", () => {
    const { fields } = waitlist().schema.waitlistEntry

    expect(fields.email).toMatchObject({ type: "string", required: true, unique: true })
    expect(fields.status).toMatchObject({
      type: ["pending", "approved", "rejected", "registered"],
      required: true,
      defaultValue: "pending",
      input: false,
      index: true,
    })
    expect(fields.queueScore).toMatchObject({ type: "number", bigint: true, sortable: true, input: false })
    expect(fields.referralCode).toMatchObject({ unique: true, input: false })
    expect(fields.referredById).toMatchObject({
      references: { model: "waitlistEntry", field: "id", onDelete: "set null" },
      index: true,
    })
    expect(fields.inviteCodeHash).toMatchObject({ unique: true, returned: false, input: false })
    expect(fields.userId?.references).toEqual({ model: "user", field: "id", onDelete: "set null" })
    expect(fields.decidedById?.references).toEqual({ model: "user", field: "id", onDelete: "set null" })
    expect(fields.createdAt).toMatchObject({ type: "date", required: true, sortable: true })
    for (const field of ["boostSeconds", "referralSucceeded", "emailConfirmed", "version"] as const) {
      expect(fields[field], field).toMatchObject({ required: true, input: false })
    }
  })

  it("declares the three compound indexes at table level", () => {
    expect(waitlist().schema.waitlistEntry.indexes).toEqual([
      { fields: ["status", "queueScore"] },
      { fields: ["status", "createdAt"] },
      { fields: ["referredById", "referralSucceeded"] },
    ])
  })

  it("generates the table, the bigint queue score and the indexes", async () => {
    const sql = await compileSql(waitlist())

    expect(sql).toMatch(/create table "waitlistEntry"/)
    expect(sql).toMatch(/"queueScore" bigint not null/)
    expect(sql).toMatch(/create index "\w+" on "waitlistEntry" \("status", "queueScore"\)/)
    expect(sql).toMatch(/create index "\w+" on "waitlistEntry" \("status", "createdAt"\)/)
    expect(sql).toMatch(/create index "\w+" on "waitlistEntry" \("referredById", "referralSucceeded"\)/)
  })

  it("round-trips a queue score beyond int32 (epoch ms)", async () => {
    const mailbox = createMailbox()
    const { auth, db } = await createWaitlistInstance({ ...mailbox.options })

    const before = Date.now()
    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })

    const [entry] = await db.findMany<WaitlistEntry>({ model: "waitlistEntry" })
    expect(entry?.queueScore).toBeGreaterThan(2 ** 31)
    expect(entry?.queueScore).toBeGreaterThanOrEqual(before)
    expect(entry?.queueScore).toBe(entry?.createdAt.getTime())
  })
})

describe("option: schema", () => {
  it("waitlistSnakeCaseSchema renames every field", () => {
    expect(Object.keys(waitlistSnakeCaseSchema.waitlistEntry.fields).sort()).toEqual(
      Object.keys(waitlist().schema.waitlistEntry.fields).sort()
    )
    for (const column of Object.values(waitlistSnakeCaseSchema.waitlistEntry.fields)) {
      expect(column).toMatch(/^[a-z]+(_[a-z]+)*$/)
    }
  })

  it("generates snake_case SQL with waitlistSnakeCaseSchema", async () => {
    const sql = await compileSql(waitlist({ schema: waitlistSnakeCaseSchema }))

    expect(sql).toMatch(/create table "waitlist_entry"/)
    expect(sql).toMatch(/"queue_score" bigint not null/)
    expect(sql).toMatch(/"referred_by_id" text references "waitlist_entry" \("id"\) on delete set null/)
    expect(sql).toMatch(/create index "\w+" on "waitlist_entry" \("status", "queue_score"\)/)
    expect(sql).not.toMatch(/"queueScore"|"waitlistEntry"/)
  })

  it("works end to end with renamed tables and columns", async () => {
    const mailbox = createMailbox()
    const { auth } = await createWaitlistInstance({ ...mailbox.options, schema: waitlistSnakeCaseSchema })

    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") })
    await auth.api.joinWaitlist({ body: { email: "a@example.com" } })
    vi.advanceTimersByTime(1000)
    await auth.api.joinWaitlist({ body: { email: "b@example.com" } })
    vi.useRealTimers()
    await auth.api.confirmWaitlistEntry({ body: { token: mailbox.tokenFor("b@example.com") } })

    const status = await auth.api.getWaitlistStatus({ query: { token: mailbox.tokenFor("b@example.com") } })
    expect(status).toMatchObject({ position: 2, queueLength: 2, emailConfirmed: true })
  })

  it("applies a custom model name and column renames", async () => {
    const sql = await compileSql(
      waitlist({ schema: { waitlistEntry: { modelName: "signup_queue", fields: { email: "email_address" } } } })
    )

    expect(sql).toMatch(/create table "signup_queue"/)
    expect(sql).toMatch(/"email_address" text not null unique/)
  })

  it("stores additionalFields written on join", async () => {
    const { auth, db } = await createWaitlistInstance({
      schema: {
        waitlistEntry: {
          additionalFields: {
            company: { type: "string", required: false },
            source: { type: "string", required: false, input: false },
          },
        },
      },
    })

    await auth.api.joinWaitlist({ body: { email: "ada@example.com", company: "Analytical Engines" } })

    const [entry] = await db.findMany<Record<string, unknown>>({ model: "waitlistEntry" })
    expect(entry?.company).toBe("Analytical Engines")
    expect(entry?.source ?? null).toBeNull()
  })

  it("never stores a client-supplied value for an input: false additional field", async () => {
    const { client, db } = await createWaitlistInstance({
      schema: { waitlistEntry: { additionalFields: { source: { type: "string", required: false, input: false } } } },
    })

    const res = await client.$fetch("/waitlist/join", {
      method: "POST",
      body: { email: "ada@example.com", source: "forged", status: "approved" },
    })

    expect(res.error).toBeNull()
    const [entry] = await db.findMany<Record<string, unknown>>({ model: "waitlistEntry" })
    expect(entry?.source ?? null).toBeNull()
    expect(entry?.status).toBe("pending")
  })
})

describe("adapter requirements", () => {
  const uniqueWarnings = async (auth: NonNullable<Parameters<typeof createWaitlistInstance>[1]>["auth"]) => {
    const lines: { level: string; message: string }[] = []
    const logger = {
      level: "debug" as const,
      log: (level: string, message: string) => {
        lines.push({ level, message })
      },
    }
    const instance = await createWaitlistInstance({}, { auth: { ...auth, logger } })
    await instance.auth.$context
    return lines.filter((line) => line.level === "warn" && line.message.includes("unique"))
  }

  it("warns at startup on the memory adapter, which does not enforce unique indexes", async () => {
    const db = { user: [], session: [], account: [], verification: [], waitlistEntry: [] }

    expect(await uniqueWarnings({ database: memoryAdapter(db) })).toHaveLength(1)
  })

  it("does not warn on an adapter that enforces them", async () => {
    expect(await uniqueWarnings({})).toEqual([])
  })
})
