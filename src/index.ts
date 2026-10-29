import { BetterAuthError } from "@better-auth/core/error"
import type { BetterAuthPlugin } from "better-auth"
import { hasManagerCheck } from "./access"
import { guestClaimHook } from "./claim"
import { enforcesUnique } from "./entries"
import { WAITLIST_ERROR_CODES } from "./error-codes"
import { createGate } from "./gate"
import { type RateLimitedEndpoint, type ResolvedWaitlistOptions, resolveOptions, type WaitlistOptions } from "./options"
import { createResetGuard } from "./reset-guard"
import {
  approveWaitlistEntries,
  boostWaitlistEntry,
  deleteWaitlistEntry,
  getWaitlistStats,
  inviteToWaitlist,
  listWaitlistEntries,
  rejectWaitlistEntries,
  requeueWaitlistEntry,
  resendWaitlistInvite,
  type WaitlistBulkResult,
} from "./routes/manager"
import { acceptWaitlistInvite, confirmWaitlistEntry, getWaitlistStatus, joinWaitlist } from "./routes/public"
import { buildSchema } from "./schema"

export { WAITLIST_ERROR_CODES, type WaitlistErrorCode } from "./error-codes"
export type { InviteReason } from "./invites"
export type {
  CanManageInput,
  GateBypassInput,
  OnJoinData,
  OnReferralSuccessData,
  OnStatusChangeData,
  RateLimitedEndpoint,
  RateLimitRule,
  SendInviteData,
  SendStatusLinkData,
  WaitlistOptions,
} from "./options"
export type { AcceptInviteResult } from "./routes/public"
export {
  type WaitlistEntry,
  type WaitlistEntryField,
  type WaitlistSchemaOptions,
  type WaitlistStatus,
  waitlistSnakeCaseSchema,
} from "./schema"
export type { WaitlistEvent } from "./state-machine"
export type { WaitlistBulkResult }

const RATE_LIMITED_PATHS = {
  join: "/waitlist/join",
  status: "/waitlist/status",
  confirm: "/waitlist/confirm",
  acceptInvite: "/waitlist/invite/accept",
} as const satisfies Record<RateLimitedEndpoint, `/waitlist/${string}`>
const RATE_LIMITED_ENDPOINTS = [
  "join",
  "status",
  "confirm",
  "acceptInvite",
] as const satisfies readonly RateLimitedEndpoint[]

function rateLimitRules(opts: ResolvedWaitlistOptions) {
  const { rateLimit } = opts
  if (rateLimit === false) return []
  return RATE_LIMITED_ENDPOINTS.map((endpoint) => ({
    ...rateLimit[endpoint],
    pathMatcher: (path: string) => path === RATE_LIMITED_PATHS[endpoint],
  }))
}

/**
 * Better Auth plugin that gates sign-up behind an Auth waitlist.
 */
export const waitlist = <O extends WaitlistOptions>(options?: O) => {
  const opts = resolveOptions(options)
  if (opts.sendStatusLink && !opts.statusLink.buildUrl) {
    throw new BetterAuthError("[waitlist] `statusLink.buildUrl` is required when `sendStatusLink` is set")
  }
  if (opts.sendInvite && !opts.invite.buildUrl) {
    throw new BetterAuthError("[waitlist] `invite.buildUrl` is required when `sendInvite` is set")
  }
  const resetGuard = createResetGuard(opts)
  return {
    id: "waitlist",
    init(ctx) {
      if (!opts.sendStatusLink) {
        ctx.logger.warn(
          "[waitlist] `sendStatusLink` is not set: nobody will receive a status link, so nobody can see their position"
        )
      }
      const emailCallbacks = (["sendStatusLink", "onExistingUserJoin", "sendInvite"] as const).filter(
        (name) => opts[name] && (name !== "sendInvite" || opts.join.autoApprove !== false)
      )
      if (emailCallbacks.length > 0 && !ctx.options.advanced?.backgroundTasks?.handler) {
        ctx.logger.warn(
          `[waitlist] ${emailCallbacks.map((name) => `\`${name}\``).join(" and ")} will be awaited inside the join request because \`advanced.backgroundTasks\` has no handler. Response timing then reveals whether an email is already known; set \`advanced.backgroundTasks.handler\` (e.g. waitUntil).`
        )
      }
      if (!hasManagerCheck(opts, ctx.hasPlugin("admin"))) {
        ctx.logger.warn(
          "[waitlist] No manager check is available: install the admin plugin or set `admin.canManage`. Until then only trusted server calls (auth.api.* without headers) can manage the waitlist."
        )
      }
      if (opts.gate.joinOnBlockedSignUp && !ctx.options.advanced?.backgroundTasks?.handler) {
        ctx.logger.warn(
          "[waitlist] `gate.joinOnBlockedSignUp` runs after the refused creation through `runInBackground`, but `advanced.backgroundTasks` has no handler, so the work is detached. Set `advanced.backgroundTasks.handler` (for example waitUntil) so a serverless runtime doesn't drop it."
        )
      }
      if (!enforcesUnique(ctx)) {
        ctx.logger.warn(
          "[waitlist] The memory adapter does not enforce unique indexes, so concurrent or repeat joins can create duplicate entries. Use an adapter backed by a database that enforces them."
        )
      }
      const gate = createGate(opts, ctx)
      return {
        options: {
          databaseHooks: {
            user: {
              create: { before: gate.before, after: gate.after },
              delete: { before: gate.beforeDelete },
            },
            account: {
              create: { before: resetGuard.beforeAccountCreate, after: resetGuard.afterAccountCreate },
            },
          },
        },
      }
    },
    hooks: { before: [guestClaimHook(opts), resetGuard.requestHook] },
    schema: buildSchema(opts.schema),
    endpoints: {
      joinWaitlist: joinWaitlist<O>(opts),
      getWaitlistStatus: getWaitlistStatus(opts),
      confirmWaitlistEntry: confirmWaitlistEntry(opts),
      acceptWaitlistInvite: acceptWaitlistInvite(opts),
      listWaitlistEntries: listWaitlistEntries(opts),
      getWaitlistStats: getWaitlistStats(opts),
      approveWaitlistEntries: approveWaitlistEntries(opts),
      rejectWaitlistEntries: rejectWaitlistEntries(opts),
      requeueWaitlistEntry: requeueWaitlistEntry(opts),
      resendWaitlistInvite: resendWaitlistInvite(opts),
      inviteToWaitlist: inviteToWaitlist(opts),
      boostWaitlistEntry: boostWaitlistEntry(opts),
      deleteWaitlistEntry: deleteWaitlistEntry(opts),
    },
    rateLimit: rateLimitRules(opts),
    $ERROR_CODES: WAITLIST_ERROR_CODES,
    options: options as NoInfer<O>,
  } satisfies BetterAuthPlugin
}

declare module "@better-auth/core" {
  interface BetterAuthPluginRegistry<AuthOptions, Options> {
    waitlist: { creator: Options extends WaitlistOptions ? typeof waitlist<Options> : typeof waitlist }
  }
}
