import type { GenericEndpointContext } from "@better-auth/core"
import { createAuthEndpoint } from "better-auth/api"
import * as z from "zod/mini"
import { managerMiddleware } from "../access"
import { logError } from "../callbacks"
import {
  boostEntry,
  deleteEntry,
  findEntryByEmail,
  findEntryById,
  findOrdered,
  getStats,
  listEntries,
  normalizeEmail,
  toPublicEntry,
} from "../entries"
import { waitlistError } from "../errors"
import { notifyJoin } from "../host"
import { clearedInvite, deliverInvite, type InviteReason, type MintedInvite, mintInvite } from "../invites"
import type { ResolvedWaitlistOptions } from "../options"
import { WAITLIST_STATUSES, type WaitlistEntry } from "../schema"
import { type Applied, type GuardedInput, type TransitionResult, transition } from "../state-machine"
import { generateReferralCode } from "../tokens"

const MAX_BULK = 100
const MAX_BOOST_SECONDS = 10 * 365 * 24 * 3600

const entryIdSchema = z.string().check(z.minLength(1), z.meta({ description: "The waitlist entry id" }))
const entryIdsSchema = z
  .array(entryIdSchema)
  .check(z.minLength(1), z.maxLength(MAX_BULK), z.meta({ description: "Waitlist entry ids" }))

/** A per-entry outcome. `Done` names what the endpoint did when the write went through. */
export interface WaitlistBulkResult<Done extends "approved" | "rejected"> {
  entryId: string
  outcome: Done | "skipped" | "invalid_transition" | "not_found" | "error"
  /** The raw invite code, with `invite.returnCodeToManager`, when an invite was issued. */
  code?: string
}

const decided = (actorUserId: string | null, now: Date) => ({ decidedById: actorUserId, decidedAt: now })

function entryOrThrow(result: TransitionResult): WaitlistEntry {
  if (result.outcome === "not_found") throw waitlistError("ENTRY_NOT_FOUND")
  if (result.outcome === "invalid_transition") throw waitlistError("INVALID_STATUS_TRANSITION")
  return toPublicEntry(result.entry)
}

const withCode = (code: string | undefined) => (code === undefined ? {} : { code })

async function approveWithInvite(
  ctx: GenericEndpointContext,
  opts: ResolvedWaitlistOptions,
  input: Omit<GuardedInput, "patch"> & { event: "approve" | "directInvite" | "resendInvite" },
  invite: MintedInvite,
  reason: InviteReason
): Promise<{ result: TransitionResult; code?: string }> {
  const result = await transition(ctx, opts, {
    ...input,
    patch: { ...invite.fields, ...decided(input.actorUserId, input.now) },
  })
  if (result.outcome !== "applied") return { result }
  return { result, ...withCode(await deliverInvite(ctx, opts, { entry: result.entry, code: invite.code, reason })) }
}

async function forEachEntry<Done extends "approved" | "rejected">(
  ctx: GenericEndpointContext,
  action: string,
  entryIds: string[],
  done: Done,
  apply: (entryId: string, secrets: string[]) => Promise<{ result: TransitionResult; code?: string }>
): Promise<WaitlistBulkResult<Done>[]> {
  const results: WaitlistBulkResult<Done>[] = []
  for (const entryId of entryIds) {
    const secrets: string[] = []
    try {
      const { result, code } = await apply(entryId, secrets)
      results.push({ entryId, outcome: result.outcome === "applied" ? done : result.outcome, ...withCode(code) })
    } catch (error) {
      logError(ctx.context, `${action} failed for one entry`, error, secrets)
      results.push({ entryId, outcome: "error" })
    }
  }
  return results
}

async function mintSecretInvite(opts: ResolvedWaitlistOptions, now: Date, secrets: string[]) {
  const invite = await mintInvite(opts, now)
  secrets.push(invite.code, invite.fields.inviteCodeHash)
  return invite
}

const queryBoolean = z.union([z.boolean(), z.stringbool()])

const listQuerySchema = z.object({
  status: z.optional(z.enum(WAITLIST_STATUSES).check(z.meta({ description: "Only entries in this status" }))),
  search: z.optional(
    z.string().check(z.meta({ description: "Matches part of the email, case-insensitively and literally" }))
  ),
  confirmed: z.optional(queryBoolean.check(z.meta({ description: "Only entries that did (true) or didn't confirm" }))),
  referredById: z.optional(z.string().check(z.meta({ description: "Only entries referred by this entry id" }))),
  sortBy: z._default(
    z.enum(["queue", "createdAt", "email"]).check(z.meta({ description: "Sort key. Default: queue" })),
    "queue"
  ),
  sortDirection: z._default(
    z.enum(["asc", "desc"]).check(z.meta({ description: "Sort direction. Default: asc" })),
    "asc"
  ),
  limit: z._default(
    z.coerce.number().check(z.int(), z.gte(1), z.lte(100), z.meta({ description: "Page size, 1-100. Default: 50" })),
    50
  ),
  offset: z._default(
    z.coerce.number().check(z.int(), z.gte(0), z.meta({ description: "Entries to skip. Default: 0" })),
    0
  ),
})

const SORT_FIELDS = { queue: "queueScore", createdAt: "createdAt", email: "email" } as const

export const listWaitlistEntries = (opts: ResolvedWaitlistOptions) =>
  createAuthEndpoint(
    "/waitlist/admin/list",
    {
      method: "GET",
      query: listQuerySchema,
      use: [managerMiddleware(opts)],
      metadata: { openapi: { operationId: "listWaitlistEntries", description: "List and search waitlist entries" } },
    },
    async (ctx) => {
      const { status, search, confirmed, referredById, sortBy, sortDirection, limit, offset } = ctx.query
      const { rows, total } = await listEntries(
        ctx.context,
        { status, search, confirmed, referredById },
        { field: SORT_FIELDS[sortBy], direction: sortDirection },
        { offset, limit }
      )
      const narrowed = Boolean(search) || confirmed !== undefined || Boolean(referredById)
      const isQueue = status === "pending" && sortBy === "queue" && !narrowed
      const entries = rows.map((row, i) => {
        const entry = toPublicEntry(row)
        if (!isQueue) return entry
        const position = sortDirection === "asc" ? offset + i + 1 : total - offset - i
        return { ...entry, position }
      })
      return ctx.json({ entries, total })
    }
  )

export const getWaitlistStats = (opts: ResolvedWaitlistOptions) =>
  createAuthEndpoint(
    "/waitlist/admin/stats",
    {
      method: "GET",
      use: [managerMiddleware(opts)],
      metadata: { openapi: { operationId: "getWaitlistStats", description: "Counts of waitlist entries" } },
    },
    async (ctx) => ctx.json(await getStats(ctx.context, new Date()))
  )

const approveBodySchema = z.union([
  z.object({ entryIds: entryIdsSchema }),
  z.object({
    next: z.int().check(z.gte(1), z.lte(MAX_BULK), z.meta({ description: "Approve the first N pending entries" })),
    confirmedOnly: z.optional(
      z.boolean().check(z.meta({ description: "Only entries that confirmed their email. Default: true" }))
    ),
  }),
])

export const approveWaitlistEntries = (opts: ResolvedWaitlistOptions) =>
  createAuthEndpoint(
    "/waitlist/admin/approve",
    {
      method: "POST",
      body: approveBodySchema,
      use: [managerMiddleware(opts)],
      metadata: {
        openapi: {
          operationId: "approveWaitlistEntries",
          description: "Approve entries by id, or the next N in the queue. Issues each a new invite.",
        },
      },
    },
    async (ctx) => {
      const { actorUserId } = ctx.context
      const now = new Date()
      const entryIds = "entryIds" in ctx.body ? ctx.body.entryIds : await nextInQueue(ctx, ctx.body)
      const results = await forEachEntry(ctx, "approve", entryIds, "approved", async (entryId, secrets) =>
        approveWithInvite(
          ctx,
          opts,
          { event: "approve", entryId, now, actorUserId },
          await mintSecretInvite(opts, now, secrets),
          "approved"
        )
      )
      return ctx.json({ results })
    }
  )

async function nextInQueue(ctx: GenericEndpointContext, input: { next: number; confirmedOnly?: boolean | undefined }) {
  const rows = await findOrdered(
    ctx.context,
    [
      { field: "status", value: "pending" },
      ...(input.confirmedOnly === false ? [] : [{ field: "emailConfirmed", value: true }]),
    ],
    { field: "queueScore", direction: "asc" },
    { offset: 0, limit: input.next }
  )
  return rows.map((row) => row.id)
}

export const rejectWaitlistEntries = (opts: ResolvedWaitlistOptions) =>
  createAuthEndpoint(
    "/waitlist/admin/reject",
    {
      method: "POST",
      body: z.object({
        entryIds: entryIdsSchema,
        reason: z.optional(
          z.string().check(z.maxLength(500), z.meta({ description: "Stored for managers; never shown publicly" }))
        ),
      }),
      use: [managerMiddleware(opts)],
      metadata: {
        openapi: { operationId: "rejectWaitlistEntries", description: "Reject entries, clearing any invite" },
      },
    },
    async (ctx) => {
      const { actorUserId } = ctx.context
      const now = new Date()
      const patch = { ...clearedInvite(), rejectionReason: ctx.body.reason ?? null, ...decided(actorUserId, now) }
      const results = await forEachEntry(ctx, "reject", ctx.body.entryIds, "rejected", async (entryId) => ({
        result: await transition(ctx, opts, { event: "reject", entryId, now, actorUserId, patch }),
      }))
      return ctx.json({ results })
    }
  )

export const requeueWaitlistEntry = (opts: ResolvedWaitlistOptions) =>
  createAuthEndpoint(
    "/waitlist/admin/requeue",
    {
      method: "POST",
      body: z.object({ entryId: entryIdSchema }),
      use: [managerMiddleware(opts)],
      metadata: {
        openapi: {
          operationId: "requeueWaitlistEntry",
          description: "Put an entry back in the queue at its original place, clearing any invite",
        },
      },
    },
    async (ctx) => {
      const { actorUserId } = ctx.context
      const now = new Date()
      const result = await transition(ctx, opts, {
        event: "requeue",
        entryId: ctx.body.entryId,
        now,
        actorUserId,
        patch: { ...clearedInvite(), ...decided(actorUserId, now) },
      })
      return ctx.json({ entry: entryOrThrow(result) })
    }
  )

export const resendWaitlistInvite = (opts: ResolvedWaitlistOptions) =>
  createAuthEndpoint(
    "/waitlist/admin/resend-invite",
    {
      method: "POST",
      body: z.object({ entryId: entryIdSchema }),
      use: [managerMiddleware(opts)],
      metadata: {
        openapi: {
          operationId: "resendWaitlistInvite",
          description: "Issue an approved entry a new invite; the old code stops working",
        },
      },
    },
    async (ctx) => {
      const { actorUserId } = ctx.context
      const now = new Date()
      const input = { event: "resendInvite", entryId: ctx.body.entryId, now, actorUserId } as const
      const { result, code } = await approveWithInvite(ctx, opts, input, await mintInvite(opts, now), "resent")
      return ctx.json({ entry: entryOrThrow(result), ...withCode(code) })
    }
  )

export const inviteToWaitlist = (opts: ResolvedWaitlistOptions) =>
  createAuthEndpoint(
    "/waitlist/admin/invite",
    {
      method: "POST",
      body: z.object({
        email: z.email().check(z.meta({ description: "The email to invite" })),
        name: z.optional(z.string().check(z.maxLength(100), z.meta({ description: "Display name" }))),
      }),
      use: [managerMiddleware(opts)],
      metadata: {
        openapi: {
          operationId: "inviteToWaitlist",
          description: "Approve an email directly, creating its entry if it isn't on the list",
        },
      },
    },
    async (ctx) => {
      const { context } = ctx
      const { actorUserId } = context
      const now = new Date()
      const email = normalizeEmail(ctx.body.email)
      const invite = await mintInvite(opts, now)

      let created: Applied
      try {
        created = await transition(ctx, opts, {
          event: "directInvite",
          now,
          actorUserId,
          patch: {
            ...invite.fields,
            ...decided(actorUserId, now),
            email,
            name: ctx.body.name,
            queueScore: now.getTime(),
            referralCode: generateReferralCode(),
          },
        })
      } catch (error) {
        const existing = await findEntryByEmail(context, email)
        if (!existing) throw error
        const input = { event: "directInvite", entryId: existing.id, now, actorUserId } as const
        const { result, code } = await approveWithInvite(ctx, opts, input, invite, "direct")
        return ctx.json({ entry: entryOrThrow(result), ...withCode(code) })
      }

      const { entry } = created
      const code = await deliverInvite(ctx, opts, { entry, code: invite.code, reason: "direct" })
      await notifyJoin(ctx, opts, entry, "manager", null)
      return ctx.json({ entry: toPublicEntry(entry), ...withCode(code) })
    }
  )

export const boostWaitlistEntry = (opts: ResolvedWaitlistOptions) =>
  createAuthEndpoint(
    "/waitlist/admin/boost",
    {
      method: "POST",
      body: z.object({
        entryId: entryIdSchema,
        seconds: z
          .int()
          .check(
            z.gte(-MAX_BOOST_SECONDS),
            z.lte(MAX_BOOST_SECONDS),
            z.meta({ description: "Seconds to move a pending entry up the queue (±10 years); negative undoes" })
          ),
      }),
      use: [managerMiddleware(opts)],
      metadata: { openapi: { operationId: "boostWaitlistEntry", description: "Move a pending entry up the queue" } },
    },
    async (ctx) => {
      const entry = await boostEntry(ctx.context, ctx.body.entryId, ctx.body.seconds, new Date())
      if (entry) return ctx.json({ entry: toPublicEntry(entry) })
      if (!(await findEntryById(ctx.context, ctx.body.entryId))) throw waitlistError("ENTRY_NOT_FOUND")
      throw waitlistError("INVALID_STATUS_TRANSITION")
    }
  )

export const deleteWaitlistEntry = (opts: ResolvedWaitlistOptions) =>
  createAuthEndpoint(
    "/waitlist/admin/delete",
    {
      method: "POST",
      body: z.object({ entryId: entryIdSchema }),
      use: [managerMiddleware(opts)],
      metadata: { openapi: { operationId: "deleteWaitlistEntry", description: "Delete an entry (erasure)" } },
    },
    async (ctx) => {
      const deleted = await deleteEntry(ctx.context, ctx.body.entryId)
      if (!deleted) throw waitlistError("ENTRY_NOT_FOUND")
      return ctx.json({ success: true })
    }
  )
