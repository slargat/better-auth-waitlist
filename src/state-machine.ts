import type { AuthContext, GenericEndpointContext } from "@better-auth/core"
import { currentAdapter, findEntryById, toPublicEntry } from "./entries"
import { notifyHost } from "./host"
import type { ResolvedWaitlistOptions } from "./options"
import { WAITLIST_MODEL, type WaitlistEntry, type WaitlistStatus } from "./schema"

/**
 * Every Status change the plugin can make. `null` in `from`
 * means the event creates the row. Nothing outside `transition()` writes
 * `status`.
 *
 * `register` from `pending` or `rejected` is the bypass path only
 * (`BYPASS_ONLY_FROM`): `transition()` allows those starting points only when
 * the input says `bypass: true`, which the gate sets for a creation it let
 * through without admission.
 */
export const TRANSITIONS = {
  join: { from: [null], to: "pending" },
  autoApprove: { from: [null], to: "approved" },
  approve: { from: ["pending", "rejected"], to: "approved" },
  directInvite: { from: [null, "pending", "rejected"], to: "approved" },
  resendInvite: { from: ["approved"], to: "approved" },
  reject: { from: ["pending", "approved"], to: "rejected" },
  requeue: { from: ["rejected", "approved"], to: "pending" },
  register: { from: ["approved", "pending", "rejected"], to: "registered" },
} as const satisfies Record<string, { from: readonly (WaitlistStatus | null)[]; to: WaitlistStatus }>

export type WaitlistEvent = keyof typeof TRANSITIONS

const BYPASS_ONLY_FROM: Partial<Record<WaitlistEvent, readonly WaitlistStatus[]>> = {
  register: ["pending", "rejected"],
}

type FromOf<E extends WaitlistEvent> = (typeof TRANSITIONS)[E]["from"][number]

/** Events that create the row. */
export type CreatingEvent = { [E in WaitlistEvent]: null extends FromOf<E> ? E : never }[WaitlistEvent]
/** Events that move an existing row. */
export type GuardedEvent = {
  [E in WaitlistEvent]: [Exclude<FromOf<E>, null>] extends [never] ? never : E
}[WaitlistEvent]

const IDEMPOTENT_EVENTS: ReadonlySet<WaitlistEvent> = new Set(["approve", "reject", "requeue", "register"])

/** A row as stored, including the fields never handed out. */
export type WaitlistEntryRow = WaitlistEntry & { inviteCodeHash?: string | null }

/**
 * The side data written in the same row update. `status` and `version` belong
 * to `transition()`, so the type rejects them.
 */
export type TransitionPatch = Record<string, unknown> & { status?: never; version?: never }

export interface Applied {
  outcome: "applied"
  entry: WaitlistEntryRow
  from: WaitlistStatus | null
  to: WaitlistStatus
}

export type TransitionResult =
  | Applied
  | { outcome: "skipped"; entry: WaitlistEntryRow }
  | { outcome: "invalid_transition"; entry: WaitlistEntryRow }
  | { outcome: "not_found" }

interface TransitionInputBase {
  patch: TransitionPatch
  now: Date
  actorUserId: string | null
}

export type CreateInput = TransitionInputBase & { event: CreatingEvent; entryId?: undefined }
export type GuardedInput = TransitionInputBase & {
  event: GuardedEvent
  entryId: string
  /** The creation skipped admission (a bypass): allows `BYPASS_ONLY_FROM`. */
  bypass?: boolean
}

/**
 * Where a transition runs: an endpoint, or (only for a `register` of a user
 * created with no endpoint context) the bare auth context.
 */
export type TransitionScope = GenericEndpointContext | AuthContext

export const contextOf = (scope: TransitionScope): AuthContext => ("context" in scope ? scope.context : scope)
const endpointOf = (scope: TransitionScope): GenericEndpointContext | null => ("context" in scope ? scope : null)

/**
 * Apply `event`, writing `patch` in the same single-row write, then fire
 * `onStatusChange`.
 *
 * - Without `entryId`, a creating event inserts the row and lets the unique
 *   indexes reject a duplicate (the caller recovers on conflict; no
 *   check-then-insert).
 * - With `entryId`, the row is read, then moved by a guarded compare-and-swap:
 *   `incrementOne` where `id`, `status` and `version` still match the read.
 *   The status read (one of `from`) is what `onStatusChange` reports as
 *   `from`; the version makes a same-status event (resend) apply once.
 * - A null result means another write got there first. The row is re-read:
 *   a resend superseded by a newer live invite is `skipped`; a row still in
 *   `from` is retried (see `MAX_STATUS_RETRIES` and `MAX_WRITES`); anything
 *   else is `not_found`, `skipped` (already in the target status, idempotent
 *   events only) or `invalid_transition`.
 */
export async function transition(
  scope: TransitionScope,
  opts: ResolvedWaitlistOptions,
  input: CreateInput
): Promise<Applied>
export async function transition(
  scope: TransitionScope,
  opts: ResolvedWaitlistOptions,
  input: GuardedInput
): Promise<TransitionResult>
export async function transition(
  scope: TransitionScope,
  opts: ResolvedWaitlistOptions,
  input: CreateInput | GuardedInput
): Promise<TransitionResult> {
  const context = contextOf(scope)
  const result = input.entryId === undefined ? await create(context, input) : await guarded(context, input)
  if (result.outcome === "applied") await notifyStatusChange(context, endpointOf(scope), opts, input, result)
  return result
}

async function create(context: AuthContext, input: CreateInput): Promise<Applied> {
  const { to } = TRANSITIONS[input.event]
  const entry = await (
    await currentAdapter(context)
  ).create<Record<string, unknown>, WaitlistEntryRow>({
    model: WAITLIST_MODEL,
    data: { ...input.patch, status: to, createdAt: input.now, updatedAt: input.now },
  })
  return { outcome: "applied", entry, from: null, to }
}

const MAX_STATUS_RETRIES = 3
const MAX_WRITES = 20

async function guarded(context: AuthContext, input: GuardedInput): Promise<TransitionResult> {
  const { from: all, to }: { from: readonly (WaitlistStatus | null)[]; to: WaitlistStatus } = TRANSITIONS[input.event]
  const bypassOnly = input.bypass ? [] : (BYPASS_ONLY_FROM[input.event] ?? [])
  const from = all.filter((status) => status === null || !bypassOnly.includes(status))
  let current = await findEntryById(context, input.entryId)
  let statusRetries = 0
  for (let writes = 0; writes < MAX_WRITES; writes++) {
    if (!current || !from.includes(current.status)) return classify(input, current)
    if (
      current.status === "approved" &&
      current.inviteCodeHash == null &&
      (await claimedBlocks(context, input, current))
    ) {
      return { outcome: "invalid_transition", entry: current }
    }
    const entry = await (
      await currentAdapter(context)
    ).incrementOne<WaitlistEntryRow>({
      model: WAITLIST_MODEL,
      where: [
        { field: "id", value: current.id },
        { field: "status", value: current.status },
        { field: "version", value: current.version },
      ],
      increment: { version: 1 },
      set: { ...input.patch, status: to, updatedAt: input.now },
    })
    if (entry) return { outcome: "applied", entry, from: current.status, to }
    const reread = await findEntryById(context, input.entryId)
    if (reread && isSuperseded(input.event, from, current, reread)) return { outcome: "skipped", entry: reread }
    const statusMoved = reread !== null && reread.status !== current.status && from.includes(reread.status)
    if (statusMoved && ++statusRetries >= MAX_STATUS_RETRIES) return { outcome: "invalid_transition", entry: reread }
    current = reread
  }
  return current ? { outcome: "invalid_transition", entry: current } : { outcome: "not_found" }
}

async function claimedBlocks(context: AuthContext, input: GuardedInput, entry: WaitlistEntryRow) {
  if (input.event === "reject" || input.event === "requeue") return true
  if (input.event !== "resendInvite") return false
  return (await context.internalAdapter.findUserByEmail(entry.email)) !== null
}

function isSuperseded(
  event: GuardedEvent,
  from: readonly (WaitlistStatus | null)[],
  before: WaitlistEntryRow,
  after: WaitlistEntryRow
) {
  return (
    event === "resendInvite" &&
    from.includes(after.status) &&
    after.inviteCodeHash != null &&
    after.inviteCodeHash !== before.inviteCodeHash
  )
}

function classify(input: GuardedInput, entry: WaitlistEntryRow | null): TransitionResult {
  if (!entry) return { outcome: "not_found" }
  if (entry.status === TRANSITIONS[input.event].to && IDEMPOTENT_EVENTS.has(input.event)) {
    return { outcome: "skipped", entry }
  }
  return { outcome: "invalid_transition", entry }
}

async function notifyStatusChange(
  context: AuthContext,
  ctx: GenericEndpointContext | null,
  opts: ResolvedWaitlistOptions,
  input: CreateInput | GuardedInput,
  result: Applied
) {
  const { onStatusChange } = opts
  if (!onStatusChange) return
  const data = {
    entry: toPublicEntry(result.entry),
    from: result.from,
    to: result.to,
    event: input.event,
    actorUserId: input.actorUserId,
  }
  await notifyHost({ context, ctx, opts, name: "onStatusChange" }, () => onStatusChange(data, ctx))
}
