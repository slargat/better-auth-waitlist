import type { AuthContext, GenericEndpointContext } from "@better-auth/core"
import { logError } from "./callbacks"
import {
  claimReferralSuccess,
  findEntryById,
  findEntryByReferralCode,
  getReferralCount,
  toPublicEntry,
} from "./entries"
import { askHost, hostScope, notifyHost, requestSecrets } from "./host"
import type { ResolvedWaitlistOptions } from "./options"
import type { WaitlistEntryRow } from "./state-machine"

const REFERRAL_CODE = /^[A-Za-z0-9]{1,64}$/

/**
 * The referrer for a join that carries `referralCode`, or null: referrals are
 * off, the code is malformed or unknown, or it is a self-referral (the
 * joiner's and the referrer's emails have the same
 * `referral.canonicalizeEmail` form; a throw counts as one).
 *
 * Called while the row is built, before any lookup by email. Whatever the
 * code is, it runs the same host steps: two `canonicalizeEmail` calls (the
 * joiner's own email stands in for a missing referrer), so neither the
 * response nor the host function's calls tell a known code from an unknown or
 * malformed one. An empty code is no code.
 */
export async function referrerFor(
  ctx: GenericEndpointContext,
  opts: ResolvedWaitlistOptions,
  email: string,
  referralCode: string | undefined
): Promise<WaitlistEntryRow | null> {
  const { enabled, canonicalizeEmail } = opts.referral
  const code = referralCode?.trim() ?? ""
  if (!enabled || code.length === 0) return null
  const referrer = REFERRAL_CODE.test(code) ? await findEntryByReferralCode(ctx.context, code.toLowerCase()) : null
  const scope = { ...hostScope(ctx, opts), name: "referral.canonicalizeEmail" }
  const canonical = (value: string) => askHost<string | null>(scope, () => canonicalizeEmail(value), null)
  const own = await canonical(email)
  const theirs = await canonical(referrer?.email ?? email)
  if (!referrer || own === null || theirs === null || own === theirs) return null
  return referrer
}

const reachedMilestone = (opts: ResolvedWaitlistOptions, entry: WaitlistEntryRow) =>
  opts.referral.successOn === "confirm" ? entry.emailConfirmed : entry.status === "registered"

/**
 * Claim the referral success for `entry` if it has a referrer and has reached
 * `referral.successOn`, then call `onReferralSuccess` once.
 *
 * - Before the claim: the referrer and its count are read. A referrer that is
 *   gone means no claim. A read that fails is logged and nothing is claimed,
 *   so the next confirm or status read can try again.
 * - The claim: one guarded write on the referred row. Only the caller whose
 *   write applied goes on, so retries and concurrent calls are safe.
 * - After the claim: nothing may stop delivery. The count is read again (it
 *   includes this claim); if that read fails, the count read before the
 *   claim plus one is used. Then `onReferralSuccess` is scheduled through
 *   `notifyHost`. It is never retried: a throw is logged and the claim stays.
 *
 * Never throws, so the request it runs in answers as it would without it.
 * Runs on confirm, after registration, and on a status read (the repair).
 * `ctx` is null only for a registration with no endpoint context.
 */
export async function claimReferral(
  context: AuthContext,
  ctx: GenericEndpointContext | null,
  opts: ResolvedWaitlistOptions,
  entry: WaitlistEntryRow
) {
  const { referredById } = entry
  if (!opts.referral.enabled || !referredById || entry.referralSucceeded || !reachedMilestone(opts, entry)) return
  const failed = (what: string) => (error: unknown) => {
    logError(context, what, error, requestSecrets(ctx, opts))
    return null
  }
  const before = await Promise.all([findEntryById(context, referredById), getReferralCount(context, referredById)])
    .then(([referrer, count]) => (referrer ? { referrer, count } : null))
    .catch(failed("referral claim failed"))
  if (!before) return
  const referred = await claimReferralSuccess(context, entry.id, referredById, new Date()).catch(
    failed("referral claim failed")
  )
  if (!referred) return
  const { onReferralSuccess } = opts
  if (!onReferralSuccess) return
  const referralCount =
    (await getReferralCount(context, referredById).catch(failed("referral count after the claim failed"))) ??
    before.count + 1
  const data = { referrer: toPublicEntry(before.referrer), referred: toPublicEntry(referred), referralCount }
  await notifyHost({ context, ctx, opts, name: "onReferralSuccess" }, () => onReferralSuccess(data, ctx))
}
