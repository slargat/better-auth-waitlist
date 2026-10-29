import type { BetterAuthPluginDBSchema, DBFieldAttribute } from "@better-auth/core/db"
import type { InferFieldsOutput } from "better-auth/db"
import { mergeSchema } from "better-auth/db"

/** Entry statuses. `registered` is terminal. */
export const WAITLIST_STATUSES = ["pending", "approved", "rejected", "registered"] as const
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number]

/** The logical model name. The plugin never uses a physical name. */
export const WAITLIST_MODEL = "waitlistEntry"

const entryFields = () =>
  ({
    email: { type: "string", required: true, unique: true },
    name: { type: "string", required: false },
    status: {
      type: [...WAITLIST_STATUSES],
      required: true,
      defaultValue: "pending",
      input: false,
      index: true,
    },
    queueScore: {
      type: "number",
      required: true,
      bigint: true,
      sortable: true,
      input: false,
      transform: { output: (value) => (typeof value === "string" ? Number(value) : value) },
    },
    boostSeconds: { type: "number", required: true, defaultValue: 0, input: false },
    referralCode: { type: "string", required: true, unique: true, input: false },
    referredById: {
      type: "string",
      required: false,
      references: { model: WAITLIST_MODEL, field: "id", onDelete: "set null" },
      index: true,
    },
    referralSucceeded: { type: "boolean", required: true, defaultValue: false, input: false },
    referralSucceededAt: { type: "date", required: false },
    emailConfirmed: { type: "boolean", required: true, defaultValue: false, input: false },
    confirmedAt: { type: "date", required: false },
    inviteCodeHash: { type: "string", required: false, unique: true, returned: false, input: false },
    inviteExpiresAt: { type: "date", required: false },
    invitedAt: { type: "date", required: false },
    userId: { type: "string", required: false, references: { model: "user", field: "id", onDelete: "set null" } },
    decidedById: {
      type: "string",
      required: false,
      references: { model: "user", field: "id", onDelete: "set null" },
    },
    decidedAt: { type: "date", required: false },
    rejectionReason: { type: "string", required: false },
    registeredAt: { type: "date", required: false },
    lastNotifiedAt: { type: "date", required: false },
    version: { type: "number", required: true, defaultValue: 0, input: false },
    createdAt: { type: "date", required: true, sortable: true },
    updatedAt: { type: "date", required: true },
  }) satisfies Record<string, DBFieldAttribute>

type EntryFields = ReturnType<typeof entryFields>
export type WaitlistEntryField = keyof EntryFields

/**
 * A waitlist entry as the plugin hands it to callbacks. `inviteCodeHash` is
 * never part of it (`returned: false`).
 */
export type WaitlistEntry = { id: string } & InferFieldsOutput<EntryFields>

export interface WaitlistSchemaOptions {
  waitlistEntry?: {
    /** Physical table name. */
    modelName?: string
    /** Physical column names, by logical field name. */
    fields?: Partial<Record<WaitlistEntryField, string>> & Record<string, string>
    /** Extra columns. The only fields a client can write on join. */
    additionalFields?: Record<string, DBFieldAttribute>
  }
}

/** Build the plugin schema, with the host's renames and additional fields applied. */
export function buildSchema(options: WaitlistSchemaOptions | undefined) {
  const entry = options?.waitlistEntry
  const schema = {
    waitlistEntry: {
      fields: { ...entry?.additionalFields, ...entryFields() },
      indexes: [
        { fields: ["status", "queueScore"] },
        { fields: ["status", "createdAt"] },
        { fields: ["referredById", "referralSucceeded"] },
      ],
    },
  } satisfies BetterAuthPluginDBSchema
  return mergeSchema(schema, {
    waitlistEntry: { modelName: entry?.modelName, fields: entry?.fields },
  })
}

/**
 * Ready-made renames for snake_case tables (Kysely, or the CLI's generated SQL).
 * Pass it as `schema`. Covers every field, which the
 * `Record` type enforces.
 */
export const waitlistSnakeCaseSchema = {
  waitlistEntry: {
    modelName: "waitlist_entry",
    fields: {
      email: "email",
      name: "name",
      status: "status",
      queueScore: "queue_score",
      boostSeconds: "boost_seconds",
      referralCode: "referral_code",
      referredById: "referred_by_id",
      referralSucceeded: "referral_succeeded",
      referralSucceededAt: "referral_succeeded_at",
      emailConfirmed: "email_confirmed",
      confirmedAt: "confirmed_at",
      inviteCodeHash: "invite_code_hash",
      inviteExpiresAt: "invite_expires_at",
      invitedAt: "invited_at",
      userId: "user_id",
      decidedById: "decided_by_id",
      decidedAt: "decided_at",
      rejectionReason: "rejection_reason",
      registeredAt: "registered_at",
      lastNotifiedAt: "last_notified_at",
      version: "version",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
} as const satisfies { waitlistEntry: { modelName: string; fields: Record<WaitlistEntryField, string> } }
