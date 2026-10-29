import type { AuthContext } from "@better-auth/core"
import {
  getCurrentAdapter,
  getCurrentDBAdapterAsyncLocalStorage,
  runWithAdapter,
  runWithTransaction,
} from "@better-auth/core/context"
import type { Where } from "@better-auth/core/db/adapter"
import { WAITLIST_MODEL, type WaitlistEntry } from "./schema"
import type { WaitlistEntryRow } from "./state-machine"

/**
 * Reads and non-Status writes on `waitlistEntry`, through logical names only.
 * Status changes go through `transition()`.
 */

/**
 * The adapter for the current scope: the transaction-scoped one inside a
 * native transaction (user creation runs in one), else the base adapter.
 *
 * Inside a transaction the base adapter must not be used and awaited: on a
 * single-connection driver (sqlite) it waits for the connection the
 * transaction holds, and never gets it.
 */
export const currentAdapter = (context: AuthContext) => getCurrentAdapter(context.adapter)
const db = currentAdapter

/**
 * True when the current scope is a native transaction that can roll back:
 * Better Auth marks one active, and the adapter has real transactions
 * (`transaction: false`, like drizzle's default, only runs the work in
 * sequence, and its writes stay when the work fails).
 */
export async function inRealTransaction(context: AuthContext) {
  try {
    const active = (await getCurrentDBAdapterAsyncLocalStorage()).getStore()?.isTransactionActive === true
    return active && context.adapter.options?.adapterConfig?.transaction !== false
  } catch {
    return false
  }
}

/**
 * Run `fn` on the base adapter, outside any transaction it was started from,
 * so its writes commit on their own and survive a rollback of that
 * transaction. Hooks queued inside run as soon as their write is done.
 *
 * Don't await it inside a transaction (see `db`): hand the promise to
 * `runInBackground`, so it runs once the transaction has released the
 * connection.
 */
export const withBaseAdapter = <T>(context: AuthContext, fn: () => Promise<T>) => runWithAdapter(context.adapter, fn)

/**
 * Run `fn` in one transaction (a real one where the adapter has them), so the
 * entry writes and the core writes (`internalAdapter`) inside it commit or
 * roll back together.
 */
export const inTransaction = <T>(context: AuthContext, fn: () => Promise<T>) => runWithTransaction(context.adapter, fn)

/**
 * Trimmed and lowercased. Applied before every write and lookup. Better Auth
 * core only lowercases, so the gate refuses a user whose email this would
 * change (a padded email would otherwise match an entry it isn't).
 */
export const normalizeEmail = (email: string) => email.trim().toLowerCase()

export const findEntryByEmail = async (context: AuthContext, email: string) =>
  (await db(context)).findOne<WaitlistEntryRow>({
    model: WAITLIST_MODEL,
    where: [{ field: "email", value: normalizeEmail(email) }],
  })

export const findEntryById = async (context: AuthContext, id: string) =>
  (await db(context)).findOne<WaitlistEntryRow>({ model: WAITLIST_MODEL, where: [{ field: "id", value: id }] })

/** The entry whose live invite has this code hash (the hash is unique), or null. */
export const findEntryByInviteHash = async (context: AuthContext, inviteCodeHash: string) =>
  (await db(context)).findOne<WaitlistEntryRow>({
    model: WAITLIST_MODEL,
    where: [{ field: "inviteCodeHash", value: inviteCodeHash }],
  })

export const countPending = async (context: AuthContext) =>
  (await db(context)).count({ model: WAITLIST_MODEL, where: [{ field: "status", value: "pending" }] })

/**
 * 1-based rank among pending entries by `(queueScore asc, id asc)`. Derived by
 * counting, never stored. Null unless the entry is pending.
 */
export async function getPosition(context: AuthContext, entry: WaitlistEntry): Promise<number | null> {
  if (entry.status !== "pending") return null
  const [ahead, tiedAhead] = await Promise.all([
    (await db(context)).count({
      model: WAITLIST_MODEL,
      where: [
        { field: "status", value: "pending" },
        { field: "queueScore", operator: "lt", value: entry.queueScore },
      ],
    }),
    (await db(context)).count({
      model: WAITLIST_MODEL,
      where: [
        { field: "status", value: "pending" },
        { field: "queueScore", value: entry.queueScore },
        { field: "id", operator: "lt", value: entry.id },
      ],
    }),
  ])
  return ahead + tiedAhead + 1
}

export interface EntrySort {
  field: "queueScore" | "createdAt" | "email"
  direction: "asc" | "desc"
}

/**
 * A page of entries in `(sort.field, id)` order, with the id tiebreak done by
 * the database (`ORDER BY id`, the same collation as the `id < x` that
 * `getPosition` counts with), never by JavaScript string order.
 *
 * Adapters sort on one field, so ties on `sort.field` are fixed up: rows
 * before the page are counted, and every group of tied values that is cut by
 * the page edge or has several rows is re-read sorted by id. Ties are rare
 * (same millisecond), so this is a few extra queries at most.
 */
export async function findOrdered(
  context: AuthContext,
  where: Where[],
  sort: EntrySort,
  page: { offset: number; limit: number }
): Promise<WaitlistEntryRow[]> {
  const sortBy = { field: sort.field, direction: sort.direction }
  const rows = await (await db(context)).findMany<WaitlistEntryRow>({ model: WAITLIST_MODEL, where, sortBy, ...page })
  const first = rows[0]
  if (!first || sort.field === "email") return rows

  const sortValue = (row: WaitlistEntryRow) => row[sort.field]
  const keyOf = (value: number | Date | string) => (value instanceof Date ? value.getTime() : value)
  const values = [...new Map(rows.map((row) => [keyOf(sortValue(row)), sortValue(row)])).values()]
  const ahead = await (
    await db(context)
  ).count({
    model: WAITLIST_MODEL,
    where: [...where, { field: sort.field, operator: sort.direction === "asc" ? "lt" : "gt", value: sortValue(first) }],
  })

  const out: WaitlistEntryRow[] = []
  for (const [i, value] of values.entries()) {
    const members = rows.filter((row) => keyOf(sortValue(row)) === keyOf(value))
    const atEdge = i === 0 || i === values.length - 1
    const [only] = members
    if (only && members.length === 1 && !atEdge) {
      out.push(only)
      continue
    }
    const group = await (
      await db(context)
    ).findMany<WaitlistEntryRow>({
      model: WAITLIST_MODEL,
      where: [...where, { field: sort.field, value }],
      sortBy: { field: "id", direction: sort.direction },
      offset: i === 0 ? Math.max(0, page.offset - ahead) : 0,
      limit: page.limit - out.length,
    })
    out.push(...group)
    if (out.length >= page.limit) break
  }
  return out
}

export interface EntryFilter {
  status?: WaitlistEntry["status"]
  search?: string
  confirmed?: boolean
  referredById?: string
}

const LITERAL_SEARCH_SCAN = 10_000

/**
 * List entries matching `filter`, in `sort` order, with the total.
 *
 * `search` matches part of the email case-insensitively and literally. Adapters
 * pass `contains` to LIKE without escaping, so a search containing `%` or `_`
 * is split at those characters into literal `contains` clauses (a superset),
 * then filtered exactly and paged here, over at most `LITERAL_SEARCH_SCAN` rows.
 */
export async function listEntries(
  context: AuthContext,
  filter: EntryFilter,
  sort: EntrySort,
  page: { offset: number; limit: number }
) {
  const where: Where[] = []
  if (filter.status) where.push({ field: "status", value: filter.status })
  if (filter.confirmed !== undefined) where.push({ field: "emailConfirmed", value: filter.confirmed })
  if (filter.referredById) where.push({ field: "referredById", value: filter.referredById })
  const search = filter.search ? normalizeEmail(filter.search) : ""
  for (const literal of search.split(/[%_]/).filter(Boolean)) {
    where.push({ field: "email", operator: "contains", value: literal, mode: "insensitive" })
  }

  if (!/[%_]/.test(search)) {
    const [rows, total] = await Promise.all([
      findOrdered(context, where, sort, page),
      (await db(context)).count({ model: WAITLIST_MODEL, where }),
    ])
    return { rows, total }
  }
  const scanned = await findOrdered(context, where, sort, { offset: 0, limit: LITERAL_SEARCH_SCAN })
  const matching = scanned.filter((row) => row.email.includes(search))
  return { rows: matching.slice(page.offset, page.offset + page.limit), total: matching.length }
}

/** Counts for the manager stats endpoint. */
export async function getStats(context: AuthContext, now: Date) {
  const count = async (where: Where[]) => (await db(context)).count({ model: WAITLIST_MODEL, where })
  const [pending, pendingConfirmed, approved, approvedExpired, rejected, registered, successfulReferrals, total] =
    await Promise.all([
      count([{ field: "status", value: "pending" }]),
      count([
        { field: "status", value: "pending" },
        { field: "emailConfirmed", value: true },
      ]),
      count([{ field: "status", value: "approved" }]),
      count([
        { field: "status", value: "approved" },
        { field: "inviteExpiresAt", operator: "lte", value: now },
      ]),
      count([{ field: "status", value: "rejected" }]),
      count([{ field: "status", value: "registered" }]),
      count([{ field: "referralSucceeded", value: true }]),
      count([]),
    ])
  return { pending, pendingConfirmed, approved, approvedExpired, rejected, registered, successfulReferrals, total }
}

/** The adapter enforces `unique` field attributes (the memory adapter doesn't). */
export const enforcesUnique = (context: AuthContext) => context.adapter.id !== "memory"

/** Successful referrals. Derived, not stored. */
export const getReferralCount = async (context: AuthContext, entryId: string) =>
  (await db(context)).count({
    model: WAITLIST_MODEL,
    where: [
      { field: "referredById", value: entryId },
      { field: "referralSucceeded", value: true },
    ],
  })

/** The entry with this public referral code (unique), or null. */
export const findEntryByReferralCode = async (context: AuthContext, referralCode: string) =>
  (await db(context)).findOne<WaitlistEntryRow>({
    model: WAITLIST_MODEL,
    where: [{ field: "referralCode", value: referralCode }],
  })

/**
 * The exactly-once referral-success claim: one guarded write
 * on the referred row, applied only while `referralSucceeded` is false and the
 * row still points at `referrerId`. Deleting the referrer sets `referredById`
 * to null (`onDelete: "set null"`), so a deleted referrer gets no claim.
 * Nothing on the referrer's row changes: `referralCount` is derived. Null
 * when the claim was already made, or the referrer is gone.
 */
export const claimReferralSuccess = async (context: AuthContext, entryId: string, referrerId: string, now: Date) =>
  (await db(context)).incrementOne<WaitlistEntryRow>({
    model: WAITLIST_MODEL,
    where: [
      { field: "id", value: entryId },
      { field: "referralSucceeded", value: false },
      { field: "referredById", value: referrerId },
    ],
    increment: { version: 1 },
    set: { referralSucceeded: true, referralSucceededAt: now, updatedAt: now },
  })

/**
 * Claim the right to send a status link now: stamps `lastNotifiedAt` only if
 * it is unset or older than `resendAfter`. Each attempt is a guarded
 * single-row write, so concurrent re-joins send at most one link per window.
 *
 * "Unset OR older" is two writes, each fully ANDed with the id, because
 * adapters group mixed AND/OR connectors differently.
 * A racer that loses the first guard also fails the second: the winner's
 * stamp is not older than the cutoff.
 */
export async function claimStatusLinkResend(context: AuthContext, entryId: string, resendAfter: number, now: Date) {
  const stamp = async (guard: Where) =>
    (await db(context)).incrementOne<WaitlistEntryRow>({
      model: WAITLIST_MODEL,
      where: [{ field: "id", value: entryId }, guard],
      increment: { version: 1 },
      set: { lastNotifiedAt: now, updatedAt: now },
    })
  const cutoff = new Date(now.getTime() - resendAfter * 1000)
  return (
    (await stamp({ field: "lastNotifiedAt", value: null })) ??
    (await stamp({ field: "lastNotifiedAt", operator: "lt", value: cutoff }))
  )
}

/** Guarded on `emailConfirmed = false`, so only the first confirmation writes. */
export const confirmEntry = async (context: AuthContext, entryId: string, now: Date) =>
  (await db(context)).incrementOne<WaitlistEntryRow>({
    model: WAITLIST_MODEL,
    where: [
      { field: "id", value: entryId },
      { field: "emailConfirmed", value: false },
    ],
    increment: { version: 1 },
    set: { emailConfirmed: true, confirmedAt: now, updatedAt: now },
  })

/**
 * Move a pending entry in the queue by `seconds` (negative undoes a boost).
 * One atomic `incrementOne` guarded on `status = pending`, so concurrent boosts
 * all apply. Null if the entry is gone or no longer pending.
 */
export const boostEntry = async (context: AuthContext, entryId: string, seconds: number, now: Date) =>
  (await db(context)).incrementOne<WaitlistEntryRow>({
    model: WAITLIST_MODEL,
    where: [
      { field: "id", value: entryId },
      { field: "status", value: "pending" },
    ],
    increment: { queueScore: -seconds * 1000, boostSeconds: seconds, version: 1 },
    set: { updatedAt: now },
  })

/**
 * Claim the entry's invite for the user being created: one guarded write, on
 * the current (transaction-scoped) adapter, that clears the invite only if the
 * hash and version are still the ones read. Exactly one creation wins; the
 * claim rolls back with a creation that fails. Null when another write got
 * there first (a concurrent claim, a resend, a reject).
 */
export const claimInvite = async (context: AuthContext, entry: WaitlistEntryRow, now: Date) =>
  (await db(context)).incrementOne<WaitlistEntryRow>({
    model: WAITLIST_MODEL,
    where: [
      { field: "id", value: entry.id },
      { field: "status", value: "approved" },
      { field: "version", value: entry.version },
      { field: "inviteCodeHash", value: entry.inviteCodeHash ?? null },
    ],
    increment: { version: 1 },
    set: { inviteCodeHash: null, inviteExpiresAt: null, updatedAt: now },
  })

const unlinkReferralsOf = async (context: AuthContext, deletedEntryId: string) =>
  (await db(context)).updateMany({
    model: WAITLIST_MODEL,
    where: [{ field: "referredById", value: deletedEntryId }],
    update: { referredById: null },
  })

async function afterErasure(context: AuthContext, row: WaitlistEntryRow | null) {
  if (row) await unlinkReferralsOf(context, row.id)
  return row
}

/** Erasure of a deleted user's entry: the one linked to it by `userId`. Null if there is none. */
export const deleteEntryOfUser = async (context: AuthContext, userId: string) =>
  afterErasure(
    context,
    await (
      await db(context)
    ).consumeOne<WaitlistEntryRow>({
      model: WAITLIST_MODEL,
      where: [{ field: "userId", value: userId }],
    })
  )

/** Remove the entry (erasure). Null if it was already gone. */
export const deleteEntry = async (context: AuthContext, entryId: string) =>
  afterErasure(
    context,
    await (
      await db(context)
    ).consumeOne<WaitlistEntryRow>({
      model: WAITLIST_MODEL,
      where: [{ field: "id", value: entryId }],
    })
  )

/** The entry without the fields that are never handed out (`returned: false`). */
export function toPublicEntry(row: WaitlistEntryRow): WaitlistEntry {
  const { inviteCodeHash: _hidden, ...entry } = row
  return entry
}
