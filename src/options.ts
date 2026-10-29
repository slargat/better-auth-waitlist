import type { GenericEndpointContext } from "@better-auth/core"
import type { Session, User } from "@better-auth/core/db"
import type { InviteReason } from "./invites"
import type { WaitlistEntry, WaitlistSchemaOptions, WaitlistStatus } from "./schema"
import type { WaitlistEvent } from "./state-machine"

export type RateLimitedEndpoint = "join" | "status" | "confirm" | "acceptInvite"

export interface RateLimitRule {
  /** Window in seconds. */
  window: number
  /** Requests allowed per window. */
  max: number
}

export interface SendStatusLinkData {
  entry: WaitlistEntry
  email: string
  /** The raw status token. Only ever exists in this payload. */
  token: string
  /** `statusLink.buildUrl(token)`. */
  url: string
  reason: "joined" | "rejoined" | "blocked-sign-up"
}

export interface SendInviteData {
  entry: WaitlistEntry
  email: string
  /** The raw invite code. Only ever exists here (and in manager responses with `returnCodeToManager`). */
  code: string
  /** `invite.buildUrl(code)`. */
  url: string
  /** Null when `invite.expiresIn` is null. */
  expiresAt: Date | null
  reason: InviteReason
}

export interface OnJoinData {
  entry: WaitlistEntry
  referrer: WaitlistEntry | null
  source: "join" | "sign-up" | "manager"
}

export interface OnReferralSuccessData {
  /** The entry whose referral code the referred entry joined with. */
  referrer: WaitlistEntry
  /** The entry that reached `referral.successOn`, with `referralSucceeded` set. */
  referred: WaitlistEntry
  /** The referrer's successful referrals, counted after this claim (derived, never stored). */
  referralCount: number
}

export interface OnStatusChangeData {
  entry: WaitlistEntry
  /** Null when the event created the entry. */
  from: WaitlistStatus | null
  to: WaitlistStatus
  event: WaitlistEvent
  /** The manager who made the change; null for public endpoints and trusted server calls. */
  actorUserId: string | null
}

/** What `gate.bypass` is asked about: the user about to be created, and the endpoint creating it (null without one). */
export interface GateBypassInput {
  user: Partial<User> & { email?: string }
  ctx: GenericEndpointContext | null
}

export interface CanManageInput {
  user: User & { role?: string | null }
  session: Session
  ctx: GenericEndpointContext
}

/**
 * Options for the waitlist plugin. Every option here is wired
 * and tested; `WAITLIST_OPTION_PATHS` below must list it.
 */
export interface WaitlistOptions {
  gate?: {
    /** Gate user creation. Default: true */
    enabled?: boolean
    /** Admission needs the matching invite code, not just approval. Default: true */
    requireInviteCode?: boolean
    /** Put blocked sign-ups on the waitlist and send them a status link. Default: false */
    joinOnBlockedSignUp?: boolean
    /**
     * Allow creation without admission. Default: `ctx?.path === "/admin/create-user"`.
     * A rule that matches on the email must also check `user.emailVerified`
     * (or a token only the invitee has): an email sign-up can type any email.
     */
    bypass?: (input: GateBypassInput) => boolean | Promise<boolean>
    /**
     * Let a user creation with no endpoint context (a direct `internalAdapter`
     * call) go on to `bypass` and admission instead of being refused. Default:
     * false (fail closed)
     */
    allowWithoutContext?: boolean
  }
  join?: {
    /** Public join endpoint is open. Default: true */
    enabled?: boolean
    /** Soft cap on pending entries. Default: undefined (none) */
    maxEntries?: number
    /** Case-insensitive domain allow-list. Default: undefined (all) */
    allowedDomains?: string[]
    /** Extra validation; return false → EMAIL_NOT_ALLOWED. Default: none */
    validate?: (input: {
      email: string
      name?: string
      emailVerified: boolean
      request?: Request
    }) => boolean | Promise<boolean>
    /**
     * Approve on join (and admit at the gate without a code). Default: false.
     * A predicate gets `emailVerified`: at the gate it says whether the user
     * being created proved the email (an IdP's verified claim); an email
     * sign-up is unverified, and so is a sign-in method that lets the user
     * type any email. A predicate that trusts a domain must check it, or the
     * host must pair it with `requireEmailVerification`. On join it is always
     * false: the invite the approval sends is the inbox proof.
     */
    autoApprove?:
      | boolean
      | ((input: { email: string; emailVerified: boolean; request?: Request }) => boolean | Promise<boolean>)
  }
  statusLink?: {
    /** Build the URL put in emails. Required when sendStatusLink is set. */
    buildUrl: (token: string) => string
    /** Minimum seconds between status-link re-sends for one entry. Default: 600 */
    resendAfter?: number
  }
  invite?: {
    /** Build the invite URL (the host's register page). Required when sendInvite is set. */
    buildUrl?: (code: string) => string
    /** Invite lifetime in seconds; null = never expires. Default: 604800 (7 days) */
    expiresIn?: number | null
    /** Code length (base62). Default: 24 */
    codeLength?: number
    /** Return raw codes in manager responses (for copy/paste invites). Default: false */
    returnCodeToManager?: boolean
    /** Invite cookie lifetime in seconds after /waitlist/invite/accept. Default: 1800 */
    cookieMaxAge?: number
    /** Header also accepted for the code. Default: "x-waitlist-invite" */
    header?: string
  }
  referral?: {
    /** Accept referral codes on join and track successes. Default: true */
    enabled?: boolean
    /**
     * The milestone at which a referral counts as successful: the referred
     * entry confirms its inbox (`/waitlist/confirm`), or registers. Default: "confirm"
     */
    successOn?: "confirm" | "register"
    /**
     * Canonical form of an email, used only to detect self-referrals (the two
     * forms equal: the code is ignored). Asked twice for every join that
     * carries a referral code, whatever the code matches; a throw counts as a
     * self-referral. Default: strips a "+tag" from the local part
     */
    canonicalizeEmail?: (email: string) => string
  }
  admin?: {
    /**
     * Full override of the manager check. Default: if the admin plugin is installed,
     * its `adminUserIds` are managers; then `permission` if set (checked against the
     * admin plugin's `roles[role].authorize`), else `user.role` in the admin plugin's
     * `adminRoles` (default ["admin"]). No admin plugin and no `canManage`: nobody
     * is a manager (warned at startup).
     */
    canManage?: (input: CanManageInput) => boolean | Promise<boolean>
    /** Access-control statement a manager's role must grant, e.g. { waitlist: ["manage"] }. Default: undefined */
    permission?: Record<string, string[]>
  }
  /** Per-endpoint rate limits, or false to disable the plugin's rules. */
  rateLimit?: false | Partial<Record<RateLimitedEndpoint, RateLimitRule>>
  schema?: WaitlistSchemaOptions
  /** Send the status link to the entry's email. The library never sends email itself. */
  sendStatusLink?: (data: SendStatusLinkData, request?: Request) => Promise<void>
  /** Send an issued invite to the entry's email: approve, direct invite, resend and auto-approve. */
  sendInvite?: (data: SendInviteData, request?: Request) => Promise<void>
  /** After any entry is created. */
  onJoin?: (data: OnJoinData, ctx: GenericEndpointContext) => Promise<void> | void
  /**
   * After every successful Status change (never when the guarded write did not
   * apply). `ctx` is null only for a `register` of a user created with no
   * endpoint context (`gate.allowWithoutContext`).
   */
  onStatusChange?: (data: OnStatusChangeData, ctx: GenericEndpointContext | null) => Promise<void> | void
  /**
   * Exactly once per referred entry, after the claim on its row is written
   * (`referral.successOn`). Never retried: a throw is logged, and the claim
   * stays. Reward through `auth.api.boostWaitlistEntry`; for guaranteed
   * delivery, write to your own outbox here (README). `ctx` is null only for
   * a registration with no endpoint context (`gate.allowWithoutContext`).
   */
  onReferralSuccess?: (data: OnReferralSuccessData, ctx: GenericEndpointContext | null) => Promise<void> | void
  /**
   * Someone with a sign-in method (at least one account: password or social)
   * joined; send "you already have an account". A Guest, a user with no
   * account, is not an existing user: they get a normal entry instead.
   */
  onExistingUserJoin?: (data: { user: User }, request?: Request) => Promise<void>
}

type OptionGroup = "gate" | "join" | "statusLink" | "invite" | "referral" | "admin"

export type WaitlistOptionPath = {
  [K in Extract<keyof WaitlistOptions, string>]-?: K extends OptionGroup
    ? `${K}.${Extract<keyof NonNullable<WaitlistOptions[K]>, string>}`
    : K
}[Extract<keyof WaitlistOptions, string>]

const optionPaths: Record<WaitlistOptionPath, true> = {
  "gate.enabled": true,
  "gate.requireInviteCode": true,
  "gate.joinOnBlockedSignUp": true,
  "gate.bypass": true,
  "gate.allowWithoutContext": true,
  "join.enabled": true,
  "join.maxEntries": true,
  "join.allowedDomains": true,
  "join.validate": true,
  "join.autoApprove": true,
  "statusLink.buildUrl": true,
  "statusLink.resendAfter": true,
  "invite.buildUrl": true,
  "invite.expiresIn": true,
  "invite.codeLength": true,
  "invite.returnCodeToManager": true,
  "invite.cookieMaxAge": true,
  "invite.header": true,
  "referral.enabled": true,
  "referral.successOn": true,
  "referral.canonicalizeEmail": true,
  "admin.canManage": true,
  "admin.permission": true,
  rateLimit: true,
  schema: true,
  sendStatusLink: true,
  sendInvite: true,
  onJoin: true,
  onStatusChange: true,
  onReferralSuccess: true,
  onExistingUserJoin: true,
}
export const WAITLIST_OPTION_PATHS = Object.keys(optionPaths)

export const DEFAULT_RATE_LIMITS = {
  join: { window: 60, max: 5 },
  status: { window: 60, max: 30 },
  confirm: { window: 60, max: 10 },
  acceptInvite: { window: 60, max: 10 },
} as const satisfies Record<RateLimitedEndpoint, RateLimitRule>

function resolveRateLimit(rateLimit: WaitlistOptions["rateLimit"]): false | Record<RateLimitedEndpoint, RateLimitRule> {
  return rateLimit === false ? false : { ...DEFAULT_RATE_LIMITS, ...rateLimit }
}

const defaultBypass = ({ ctx }: GateBypassInput) => ctx?.path === "/admin/create-user"

const defaultCanonicalizeEmail = (email: string) => {
  const at = email.lastIndexOf("@")
  const local = email.slice(0, at)
  const plus = local.indexOf("+")
  return plus === -1 ? email : `${local.slice(0, plus)}${email.slice(at)}`
}

/** Defaults spread into one `opts` object (the email-otp pattern). */
export function resolveOptions(options: WaitlistOptions = {}) {
  return {
    ...options,
    gate: {
      enabled: options.gate?.enabled ?? true,
      requireInviteCode: options.gate?.requireInviteCode ?? true,
      joinOnBlockedSignUp: options.gate?.joinOnBlockedSignUp ?? false,
      bypass: options.gate?.bypass ?? defaultBypass,
      allowWithoutContext: options.gate?.allowWithoutContext ?? false,
    },
    join: {
      enabled: true,
      autoApprove: false,
      ...options.join,
    },
    statusLink: {
      buildUrl: options.statusLink?.buildUrl,
      resendAfter: options.statusLink?.resendAfter ?? 600,
    },
    invite: {
      buildUrl: options.invite?.buildUrl,
      expiresIn: options.invite?.expiresIn === undefined ? 604_800 : options.invite.expiresIn,
      codeLength: options.invite?.codeLength ?? 24,
      returnCodeToManager: options.invite?.returnCodeToManager ?? false,
      cookieMaxAge: options.invite?.cookieMaxAge ?? 1800,
      header: options.invite?.header ?? "x-waitlist-invite",
    },
    referral: {
      enabled: options.referral?.enabled ?? true,
      successOn: options.referral?.successOn ?? "confirm",
      canonicalizeEmail: options.referral?.canonicalizeEmail ?? defaultCanonicalizeEmail,
    },
    admin: { ...options.admin },
    rateLimit: resolveRateLimit(options.rateLimit),
  }
}

export type ResolvedWaitlistOptions = ReturnType<typeof resolveOptions>
