import type { GenericEndpointContext } from "@better-auth/core"
import { claimStatusLinkResend, countPending, findEntryByEmail } from "./entries"
import { hostScope, isEmailAllowed, notifyJoin, sendStatusLink } from "./host"
import { deliverInvite, type MintedInvite } from "./invites"
import type { OnJoinData, ResolvedWaitlistOptions, SendStatusLinkData } from "./options"
import { type TransitionPatch, transition, type WaitlistEntryRow } from "./state-machine"

/**
 * The join flow every way onto the list shares: the public
 * join endpoint and a blocked sign-up (`gate.joinOnBlockedSignUp`). The
 * manager's direct invite has its own path (it also approves existing rows).
 */

/**
 * The join rules that look only at the email string:
 * closed, then `allowedDomains` and `join.validate`. Null when the
 * email may join.
 */
export async function joinRefusal(
  ctx: GenericEndpointContext,
  opts: ResolvedWaitlistOptions,
  input: { email: string; name?: string; emailVerified: boolean }
): Promise<"WAITLIST_CLOSED" | "EMAIL_NOT_ALLOWED" | null> {
  if (!opts.join.enabled) return "WAITLIST_CLOSED"
  const allowed = await isEmailAllowed(hostScope(ctx, opts), { ...input, request: ctx.request })
  return allowed ? null : "EMAIL_NOT_ALLOWED"
}

/** The soft cap (step 3): `count(pending) >= join.maxEntries`. */
export async function isFull(ctx: GenericEndpointContext, opts: ResolvedWaitlistOptions) {
  const { maxEntries } = opts.join
  return maxEntries !== undefined && (await countPending(ctx.context)) >= maxEntries
}

export interface NewEntry {
  email: string
  now: Date
  event: "join" | "autoApprove"
  /** The whole row, built before any lookup. */
  patch: TransitionPatch
  /** The invite an `autoApprove` join issues, minted once. */
  invite: MintedInvite | null
  /** The status-link `reason` for a new entry and for an existing one. */
  reasons: { created: SendStatusLinkData["reason"]; existing: SendStatusLinkData["reason"] }
  source: OnJoinData["source"]
  /** The referrer the row's `referredById` points at, for `onJoin`. */
  referrer: WaitlistEntryRow | null
}

/**
 * Step 5: create the entry and let the unique email index reject a duplicate
 * (no check-then-insert). A new entry gets its status link, its invite (auto
 * approve) and `onJoin`. An existing one is never changed; only its status
 * link is re-sent, through the guarded `statusLink.resendAfter` throttle.
 */
export async function addToWaitlist(ctx: GenericEndpointContext, opts: ResolvedWaitlistOptions, input: NewEntry) {
  const { context } = ctx
  const { email, now, event, patch, invite, reasons, source, referrer } = input
  let entry: WaitlistEntryRow
  try {
    ;({ entry } = await transition(ctx, opts, { event, now, patch, actorUserId: null }))
  } catch (error) {
    const existing = await findEntryByEmail(context, email)
    if (!existing) throw error
    if (opts.sendStatusLink) {
      const claimed = await claimStatusLinkResend(context, existing.id, opts.statusLink.resendAfter, now)
      if (claimed) await sendStatusLink(ctx, opts, claimed, reasons.existing)
    }
    return
  }
  await sendStatusLink(ctx, opts, entry, reasons.created)
  if (invite) await deliverInvite(ctx, opts, { entry, code: invite.code, reason: "auto" })
  await notifyJoin(ctx, opts, entry, source, referrer)
}
