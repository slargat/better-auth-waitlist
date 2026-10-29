import type { AuthContext, GenericEndpointContext } from "@better-auth/core"
import type { User } from "@better-auth/core/db"
import { expireCookie } from "better-auth/cookies"
import { logError } from "./callbacks"
import {
  claimInvite,
  deleteEntryOfUser,
  findEntryByEmail,
  inRealTransaction,
  normalizeEmail,
  withBaseAdapter,
} from "./entries"
import { waitlistError } from "./errors"
import {
  askHost,
  type HostScope,
  inviteCookie,
  type JoinQuestion,
  notifyJoin,
  requestSecrets,
  shouldAutoApprove,
} from "./host"
import { clearedInvite, hasLiveInvite } from "./invites"
import { addToWaitlist, isFull, joinRefusal } from "./join"
import type { ResolvedWaitlistOptions } from "./options"
import { claimReferral } from "./referrals"
import { contextOf, type TransitionScope, transition, type WaitlistEntryRow } from "./state-machine"
import { generateReferralCode, inviteCodeMatches } from "./tokens"

/**
 * The sign-up gate: `databaseHooks.user.create.before` and
 * `.after`, plus `user.delete.before` for erasure, returned from `init()`. It
 * runs on user *creation* only, on every path that creates one; sign-in is
 * never gated.
 */

/**
 * The invite code the request presents: the `invite.header` header first, then
 * the signed invite cookie. The body is never read, so the core sign-up body
 * schemas stay untouched. A cookie that fails its signature counts as a
 * presented (wrong) code.
 */
export async function presentedCode(ctx: GenericEndpointContext, opts: ResolvedWaitlistOptions) {
  const header = ctx.headers?.get(opts.invite.header)
  if (header) return header
  const { name } = inviteCookie(ctx.context, opts)
  if (ctx.getCookie(name) === null) return null
  return (await ctx.getSignedCookie(name, ctx.context.secret)) || ""
}

const refusal = (code: string | null) =>
  waitlistError(code === null ? "WAITLIST_INVITE_REQUIRED" : "INVALID_INVITE_CODE")

/**
 * The invite check: null unless `entry` is approved with a live invite;
 * otherwise whether `code` is that invite's code (`byCode`), which proves the
 * inbox it was sent to.
 */
export async function liveInvite(entry: WaitlistEntryRow | null, code: string | null, now: Date) {
  if (entry?.status !== "approved" || !hasLiveInvite(entry, now)) return null
  const byCode = code !== null && entry.inviteCodeHash != null && (await inviteCodeMatches(code, entry.inviteCodeHash))
  return { byCode }
}

type CreatingUser = Partial<User> & Record<string, unknown>

type Decision = { kind: "bypass" } | { kind: "admitted"; byCode: boolean } | { kind: "autoApprove" }

/**
 * Whether the gate admits `question.email` (step 5), without consuming
 * anything: `approved` with a live invite and, when `requireInviteCode`, the
 * matching code (an email `join.autoApprove` approves needs none, whatever
 * code is presented); or no entry and `join.autoApprove`, whose approved
 * entry `after` creates once the user exists. A `registered` entry never
 * admits: one invite gives one account. `inboxProven` (say, a reset token
 * sent to the inbox) stands in for the code. Returns the decision and the
 * entry it read, or null.
 *
 * `autoApprove` is asked once for every email that reaches admission, whatever
 * its entry, so the timing doesn't say which branch ran.
 */
export async function admission(
  scope: HostScope,
  question: JoinQuestion,
  code: string | null,
  now: Date,
  { inboxProven = false }: { inboxProven?: boolean } = {}
): Promise<{ decision: Decision; entry: WaitlistEntryRow | null } | null> {
  const { context, ctx, opts } = scope
  const entry = await findEntryByEmail(context, question.email)
  const autoApproved = await shouldAutoApprove(scope, question)
  const invite = await liveInvite(entry, code, now)
  if (entry && invite) {
    const { byCode } = invite
    if (!byCode && !inboxProven && opts.gate.requireInviteCode && !autoApproved) return null
    return { decision: { kind: "admitted", byCode }, entry }
  }
  if (entry || !ctx || !autoApproved) return null
  return { decision: { kind: "autoApprove" }, entry: null }
}

export function createGate(opts: ResolvedWaitlistOptions, authContext: AuthContext) {
  const scopeOf = (endpoint: GenericEndpointContext | null | undefined) => {
    const ctx = endpoint ?? null
    return { ctx, context: ctx?.context ?? authContext }
  }

  const decisions = new WeakMap<object, Map<string, Decision>>()
  const NO_ENDPOINT = {}
  const MAX_DECISIONS = 1000
  const decide = (ctx: GenericEndpointContext | null, email: unknown, decision: Decision | null) => {
    if (typeof email !== "string" || email.length === 0) return
    const key = ctx ?? NO_ENDPOINT
    const map = decisions.get(key) ?? new Map<string, Decision>()
    decisions.set(key, map)
    const normalized = normalizeEmail(email)
    map.delete(normalized)
    if (!decision) return
    map.set(normalized, decision)
    const oldest = map.keys().next().value
    if (map.size > MAX_DECISIONS && oldest !== undefined) map.delete(oldest)
  }
  const takeDecision = (ctx: GenericEndpointContext | null, email: string) => {
    const map = decisions.get(ctx ?? NO_ENDPOINT)
    const normalized = normalizeEmail(email)
    const decision = map?.get(normalized) ?? null
    map?.delete(normalized)
    return decision
  }

  async function admits(
    ctx: GenericEndpointContext | null,
    context: AuthContext,
    user: CreatingUser,
    email: string,
    code: string | null,
    secrets: string[]
  ): Promise<Decision | null> {
    const now = new Date()
    const question = { email, emailVerified: user.emailVerified === true, request: ctx?.request }
    const admitted = await admission({ context, ctx, opts, secrets }, question, code, now)
    if (!admitted?.entry || !(await inRealTransaction(context))) return admitted?.decision ?? null
    return (await claimInvite(context, admitted.entry, now)) !== null ? admitted.decision : null
  }

  async function before(user: CreatingUser, endpoint: GenericEndpointContext | null | undefined) {
    const { ctx, context } = scopeOf(endpoint)
    if (!opts.gate.enabled) return decide(ctx, user.email, { kind: "bypass" })
    decide(ctx, user.email, null)
    if (!ctx && !opts.gate.allowWithoutContext) throw refusal(null)
    const code = ctx ? await presentedCode(ctx, opts) : null
    const secrets = code ? [code] : []
    const { bypass } = opts.gate
    if (await askHost({ context, ctx, opts, secrets, name: "gate.bypass" }, () => bypass({ user, ctx }), false)) {
      return decide(ctx, user.email, { kind: "bypass" })
    }
    const email = typeof user.email === "string" ? user.email : ""
    if (!email || email !== normalizeEmail(email)) throw refusal(code)
    const decision = await admits(ctx, context, user, email, code, secrets)
    if (decision) return decide(ctx, email, decision)
    if (ctx && opts.gate.joinOnBlockedSignUp) joinBlockedSignUp(ctx, user, email)
    throw refusal(code)
  }

  function joinBlockedSignUp(ctx: GenericEndpointContext, user: CreatingUser, email: string) {
    const work = withBaseAdapter(ctx.context, () => blockedJoin(ctx, user, email)).catch((error) =>
      logError(ctx.context, "joinOnBlockedSignUp failed", error, requestSecrets(ctx, opts))
    )
    ctx.context.runInBackground(work)
  }

  async function blockedJoin(ctx: GenericEndpointContext, user: CreatingUser, email: string) {
    const name = typeof user.name === "string" && user.name.length > 0 ? user.name : undefined
    const emailVerified = user.emailVerified === true
    if ((await joinRefusal(ctx, opts, { email, name, emailVerified })) || (await isFull(ctx, opts))) return
    const now = new Date()
    await addToWaitlist(ctx, opts, {
      email,
      now,
      event: "join",
      invite: null,
      patch: {
        email,
        name,
        queueScore: now.getTime(),
        referralCode: generateReferralCode(),
        emailConfirmed: emailVerified,
        ...(emailVerified ? { confirmedAt: now } : {}),
        ...(opts.sendStatusLink ? { lastNotifiedAt: now } : {}),
      },
      reasons: { created: "blocked-sign-up", existing: "blocked-sign-up" },
      source: "sign-up",
      referrer: null,
    })
  }

  async function after(user: User & Record<string, unknown>, endpoint: GenericEndpointContext | null | undefined) {
    const { ctx, context } = scopeOf(endpoint)
    try {
      const decision = takeDecision(ctx, user.email)
      if (decision?.kind === "autoApprove" && ctx) await createAutoApproved(ctx, user.email)
      const inboxProven = (decision?.kind === "admitted" && decision.byCode) || user.emailVerified === true
      const entry = await registerUser(ctx ?? authContext, opts, user, {
        bypass: decision?.kind === "bypass",
        inboxProven,
      })
      if (entry) await claimReferral(context, ctx, opts, entry)
    } catch (error) {
      logError(context, "register after sign-up failed", error, requestSecrets(ctx, opts))
    } finally {
      if (ctx) clearInviteCookie(ctx, opts)
    }
  }

  async function createAutoApproved(ctx: GenericEndpointContext, email: string) {
    const now = new Date()
    let created: WaitlistEntryRow
    try {
      ;({ entry: created } = await transition(ctx, opts, {
        event: "autoApprove",
        now,
        actorUserId: null,
        patch: { email, queueScore: now.getTime(), referralCode: generateReferralCode(), invitedAt: now },
      }))
    } catch (error) {
      if (await findEntryByEmail(ctx.context, email)) return
      throw error
    }
    await notifyJoin(ctx, opts, created, "sign-up", null)
  }

  async function beforeDelete(
    user: User & Record<string, unknown>,
    endpoint: GenericEndpointContext | null | undefined
  ) {
    await deleteEntryOfUser(scopeOf(endpoint).context, user.id)
  }

  return { before, after, beforeDelete }
}

function clearInviteCookie(ctx: GenericEndpointContext, opts: ResolvedWaitlistOptions) {
  const cookie = inviteCookie(ctx.context, opts)
  if (ctx.getCookie(cookie.name) !== null) expireCookie(ctx, cookie)
}

/**
 * Move the entry for `user.email` to `registered`, with the user id, clearing
 * the invite: from `approved` on the gate path, and from
 * `pending` or `rejected` only with `bypass` (the creation skipped admission).
 * Idempotent: no entry, or one already registered, writes nothing. Returns
 * the entry as it now is, or null when there is none.
 *
 * `inboxProven` (the invite code was presented, or the user's email is
 * verified) also confirms an unconfirmed entry in the same write, so
 * `referral.successOn: "confirm"` counts a referred person who registers
 * without ever opening the status link.
 */
export async function registerUser(
  scope: TransitionScope,
  opts: ResolvedWaitlistOptions,
  user: { id: string; email: string },
  { bypass = false, inboxProven = false }: { bypass?: boolean; inboxProven?: boolean } = {}
) {
  const entry = await findEntryByEmail(contextOf(scope), user.email)
  if (!entry || entry.status === "registered") return entry
  const now = new Date()
  const result = await transition(scope, opts, {
    event: "register",
    entryId: entry.id,
    now,
    actorUserId: null,
    bypass,
    patch: {
      userId: user.id,
      registeredAt: now,
      ...clearedInvite(),
      ...(inboxProven && !entry.emailConfirmed ? { emailConfirmed: true, confirmedAt: now } : {}),
    },
  })
  return result.outcome === "not_found" ? null : result.entry
}
