import type { GenericEndpointContext } from "@better-auth/core"
import { APIError } from "@better-auth/core/error"
import { createAuthMiddleware, getAuthoritativeSessionFromCtx } from "better-auth/api"
import type { Role } from "better-auth/plugins/access"
import type { AdminOptions } from "better-auth/plugins/admin"
import { defaultRoles } from "better-auth/plugins/admin/access"
import { waitlistError } from "./errors"
import { askHost } from "./host"
import type { CanManageInput, ResolvedWaitlistOptions } from "./options"

/**
 * The manager check every manager endpoint runs first.
 *
 * - A trusted server call (`auth.api.*` with no `headers` and no `request`)
 *   passes without a session, with no actor.
 * - Anything else needs an authoritative session, read with
 *   `getAuthoritativeSessionFromCtx` so a cached cookie session can't keep a
 *   demoted manager in. The user (and so the role) is then re-read from the
 *   database, because a secondary-storage session still carries the user as it
 *   was at sign-in. No session (or no user) is 401; a user who isn't a
 *   manager is 403 `NOT_ALLOWED_TO_MANAGE_WAITLIST`.
 *
 * Handlers read the actor from `ctx.context.actorUserId`.
 */
export const managerMiddleware = (opts: ResolvedWaitlistOptions) =>
  createAuthMiddleware(async (ctx): Promise<{ actorUserId: string | null }> => {
    if (!ctx.request && !ctx.headers) return { actorUserId: null }
    const session = await getAuthoritativeSessionFromCtx(ctx)
    const stored = session ? await ctx.context.internalAdapter.findUserById(session.user.id) : null
    if (!session || !stored) throw APIError.fromStatus("UNAUTHORIZED")
    const role = "role" in stored && typeof stored.role === "string" ? stored.role : null
    if (!(await canManage(opts, { user: { ...stored, role }, session: session.session, ctx }))) {
      throw waitlistError("NOT_ALLOWED_TO_MANAGE_WAITLIST")
    }
    return { actorUserId: stored.id }
  })

function canManage(opts: ResolvedWaitlistOptions, input: CanManageInput) {
  const { canManage: override, permission } = opts.admin
  if (override) {
    const scope = { context: input.ctx.context, ctx: input.ctx, opts, name: "admin.canManage" }
    return askHost(scope, () => override(input), false)
  }
  const adminOptions = readAdminOptions(input.ctx)
  if (!adminOptions) return false
  const { user } = input
  if (adminOptions.adminUserIds?.includes(user.id)) return true
  const roles = (user.role || adminOptions.defaultRole || "user").split(",")
  if (permission) {
    const acRoles: Partial<Record<string, Role>> = adminOptions.roles ?? defaultRoles
    return roles.some((role) => acRoles[role]?.authorize(permission).success === true)
  }
  const { adminRoles = ["admin"] } = adminOptions
  const managerRoles = (Array.isArray(adminRoles) ? adminRoles : adminRoles.split(",")).map((role) => role.trim())
  return roles.some((role) => managerRoles.includes(role))
}

function readAdminOptions(ctx: GenericEndpointContext): AdminOptions | null {
  const plugin = ctx.context.options.plugins?.find((candidate) => candidate.id === "admin")
  return plugin ? (plugin.options ?? {}) : null
}

/** True when some manager check can pass: `canManage` or the admin plugin. */
export const hasManagerCheck = (opts: ResolvedWaitlistOptions, hasAdminPlugin: boolean) =>
  Boolean(opts.admin.canManage) || hasAdminPlugin
