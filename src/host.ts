import type { AuthContext, GenericEndpointContext } from "@better-auth/core"
import { logError, runCallback } from "./callbacks"
import { normalizeEmail, toPublicEntry } from "./entries"
import type { OnJoinData, ResolvedWaitlistOptions, SendStatusLinkData } from "./options"
import type { WaitlistEntryRow } from "./state-machine"
import { createStatusToken } from "./tokens"

/** The signed invite cookie, `<cookiePrefix>.waitlist_invite`, through `createAuthCookie` (prefix and cross-subdomain settings). */
export const inviteCookie = (context: AuthContext, opts: ResolvedWaitlistOptions) =>
  context.createAuthCookie("waitlist_invite", { maxAge: opts.invite.cookieMaxAge })

const CREDENTIAL_FIELDS = new Set([
  "password",
  "newPassword",
  "currentPassword",
  "code",
  "otp",
  "token",
  "backupCode",
  "userCode",
  "deviceCode",
  "sessionToken",
  "idToken",
  "accessToken",
  "refreshToken",
  "codeVerifier",
  "signature",
  "nonce",
  "idTokenNonce",
  "popupNonce",
  "secret",
])

function credentialsIn(source: unknown, depth = 0, credential = false): unknown[] {
  if (typeof source === "string") return credential ? [source] : []
  if (typeof source !== "object" || source === null || depth > 3) return []
  return Object.entries(source).flatMap(([key, value]) =>
    credentialsIn(value, depth + 1, credential || CREDENTIAL_FIELDS.has(key))
  )
}

/**
 * The secrets a request carries, so a host error that quotes the request (or
 * the endpoint context handed to a callback) can't leak them into a log: the
 * invite code (header, raw cookie value), every credential field of the body
 * (`CREDENTIAL_FIELDS`: passwords, codes, status tokens, ...) and a status
 * token in the query, each also as it appears URL-encoded.
 */
export function requestSecrets(ctx: GenericEndpointContext | null, opts: ResolvedWaitlistOptions): string[] {
  if (!ctx) return []
  const query: unknown = ctx.query
  const values = [
    ctx.headers?.get(opts.invite.header),
    ctx.getCookie(inviteCookie(ctx.context, opts).name),
    ...credentialsIn(ctx.body),
    ...credentialsIn(query),
  ].filter((value): value is string => typeof value === "string" && value.length > 0)
  return values.flatMap((value) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])
}

/** Where host code runs: the auth context, the endpoint (null for a creation with none), and what to redact. */
export interface HostScope {
  context: AuthContext
  ctx: GenericEndpointContext | null
  opts: ResolvedWaitlistOptions
  /** Secrets beyond the request's own (the codes and tokens in this call's payload). */
  secrets?: string[]
}

/** The `HostScope` of an endpoint. */
export const hostScope = (
  ctx: GenericEndpointContext,
  opts: ResolvedWaitlistOptions,
  secrets?: string[]
): HostScope => ({
  context: ctx.context,
  ctx,
  opts,
  secrets,
})

const secretsOf = ({ ctx, opts, secrets = [] }: HostScope) => [...secrets, ...requestSecrets(ctx, opts)]

/**
 * The one way the plugin calls a host callback: through `runCallback` (after
 * commit, background, logged on failure), with the request's secrets added to
 * the scope's.
 */
export function notifyHost(scope: HostScope & { name: string }, callback: () => Promise<void> | void) {
  return runCallback(scope.context, scope.name, callback, { secrets: secretsOf(scope) })
}

/**
 * The one way the plugin asks a host function a question (`join.validate`,
 * `join.autoApprove`, `gate.bypass`, `admin.canManage`,
 * `referral.canonicalizeEmail`). Callbacks that *do* something go through
 * `notifyHost`; these return an answer, so a throw is logged (redacted, like a
 * callback's, with the request's secrets added) and the answer is `fallback`.
 * Nothing a host throws reaches a public response.
 */
export async function askHost<T>(
  scope: HostScope & { name: string },
  question: () => T | Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await question()
  } catch (error) {
    logError(scope.context, `${scope.name} threw`, error, secretsOf(scope))
    return fallback
  }
}

/**
 * `allowedDomains` (case-insensitive, on the part after `@`), then
 * `join.validate`. A throwing `validate` counts as "not allowed".
 */
export async function isEmailAllowed(scope: HostScope, input: JoinQuestion & { name?: string }) {
  const { allowedDomains, validate } = scope.opts.join
  if (allowedDomains) {
    const domain = input.email.slice(input.email.lastIndexOf("@") + 1)
    if (!allowedDomains.some((allowed) => normalizeEmail(allowed) === domain)) return false
  }
  return validate ? await askHost({ ...scope, name: "join.validate" }, () => validate(input), false) : true
}

/** What `join.validate` and `join.autoApprove` are asked about. */
export interface JoinQuestion {
  email: string
  /** True only when the user being created has a verified email (an IdP's claim); always false on join. */
  emailVerified: boolean
  request?: Request
}

/** `join.autoApprove` as a boolean or a predicate. A throwing predicate counts as false. */
export async function shouldAutoApprove(scope: HostScope, input: JoinQuestion) {
  const { autoApprove } = scope.opts.join
  if (typeof autoApprove !== "function") return autoApprove
  return askHost({ ...scope, name: "join.autoApprove" }, () => autoApprove(input), false)
}

/** `onJoin` for a created entry, through `notifyHost`. */
export async function notifyJoin(
  ctx: GenericEndpointContext,
  opts: ResolvedWaitlistOptions,
  entry: WaitlistEntryRow,
  source: OnJoinData["source"],
  referrer: WaitlistEntryRow | null
) {
  const { onJoin } = opts
  if (!onJoin) return
  const data = { entry: toPublicEntry(entry), referrer: referrer && toPublicEntry(referrer), source }
  await notifyHost({ ...hostScope(ctx, opts), name: "onJoin" }, () => onJoin(data, ctx))
}

/**
 * Send the status link for `entry`, if `sendStatusLink` is set. `buildUrl`
 * runs inside the callback: a throw is logged (redacted) and the caller's
 * response is unchanged.
 */
export async function sendStatusLink(
  ctx: GenericEndpointContext,
  opts: ResolvedWaitlistOptions,
  entry: WaitlistEntryRow,
  reason: SendStatusLinkData["reason"]
) {
  const { sendStatusLink: send } = opts
  const { buildUrl } = opts.statusLink
  if (!send || !buildUrl) return
  const token = await createStatusToken(entry.id, ctx.context.secret)
  await notifyHost({ ...hostScope(ctx, opts, [token]), name: "sendStatusLink" }, () =>
    send({ entry: toPublicEntry(entry), email: entry.email, token, url: buildUrl(token), reason }, ctx.request)
  )
}
