import type { GenericEndpointContext } from "@better-auth/core"
import type { Account } from "@better-auth/core/db"
import { createAuthMiddleware } from "better-auth/api"
import { logError } from "./callbacks"
import { normalizeEmail } from "./entries"
import { waitlistError } from "./errors"
import { admission, registerUser } from "./gate"
import { hostScope, requestSecrets } from "./host"
import type { ResolvedWaitlistOptions } from "./options"
import { findUser } from "./users"

const REQUEST_PATH = "/request-password-reset"
const RESET_PATH = "/reset-password"

const RESET_REQUESTED = {
  status: true,
  message: "If this email exists in our system, check your email for the reset link",
}

async function isBlockedGuest(ctx: GenericEndpointContext, opts: ResolvedWaitlistOptions, email: string) {
  const found = await findUser(ctx.context, email)
  const question = {
    email: normalizeEmail(found?.user.email ?? email),
    emailVerified: found?.user.emailVerified === true,
    request: ctx.request,
  }
  const admitted = await admission(hostScope(ctx, opts), question, null, new Date(), { inboxProven: true })
  return found?.isGuest === true && admitted === null
}

export function createResetGuard(opts: ResolvedWaitlistOptions) {
  const requestHook = {
    matcher: (ctx: { path?: string }) => ctx.path === REQUEST_PATH,
    handler: createAuthMiddleware(async (ctx) => {
      if (!opts.gate.enabled || !ctx.context.options.emailAndPassword?.sendResetPassword) return
      const email: unknown = ctx.body?.email
      if (typeof email !== "string") return
      if (!(await isBlockedGuest(ctx, opts, email))) return
      await ctx.context.internalAdapter.findVerificationValue("dummy-verification-token")
      return ctx.json(RESET_REQUESTED)
    }),
  }

  async function beforeAccountCreate(
    account: Partial<Account> & Record<string, unknown>,
    ctx: GenericEndpointContext | null | undefined
  ) {
    const userId = resetUserId(account, ctx)
    if (!opts.gate.enabled || !ctx || !userId) return
    const user = await ctx.context.internalAdapter.findUserById(userId)
    if (user && (await isBlockedGuest(ctx, opts, user.email))) throw waitlistError("WAITLIST_INVITE_REQUIRED")
  }

  async function afterAccountCreate(
    account: Account & Record<string, unknown>,
    ctx: GenericEndpointContext | null | undefined
  ) {
    const userId = resetUserId(account, ctx)
    if (!opts.gate.enabled || !ctx || !userId) return
    try {
      const user = await ctx.context.internalAdapter.findUserById(userId)
      if (user) await registerUser(ctx, opts, user, { inboxProven: true })
    } catch (error) {
      logError(ctx.context, "register after password reset failed", error, requestSecrets(ctx, opts))
    }
  }

  return { requestHook, beforeAccountCreate, afterAccountCreate }
}

function resetUserId(account: Partial<Account>, ctx: GenericEndpointContext | null | undefined) {
  const ok = ctx?.path === RESET_PATH && account.providerId === "credential" && typeof account.userId === "string"
  return ok ? account.userId : null
}
