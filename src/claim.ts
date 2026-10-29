import type { GenericEndpointContext } from "@better-auth/core"
import type { User } from "@better-auth/core/db"
import { APIError, BASE_ERROR_CODES } from "@better-auth/core/error"
import { createAuthMiddleware } from "better-auth/api"
import { setSessionCookie } from "better-auth/cookies"
import { parseUserOutput } from "better-auth/db"
import { claimInvite, findEntryByEmail, inRealTransaction, inTransaction, normalizeEmail } from "./entries"
import { createGate, liveInvite, presentedCode } from "./gate"
import type { ResolvedWaitlistOptions } from "./options"
import { findUser } from "./users"

const SIGN_UP_PATH = "/sign-up/email"

interface SignUpBody {
  name: string
  email: string
  password: string
  rememberMe?: boolean
}

function signUpBody(body: unknown): SignUpBody | null {
  if (typeof body !== "object" || body === null) return null
  const { name, email, password, rememberMe } = body as Record<string, unknown>
  if (typeof name !== "string" || typeof email !== "string" || typeof password !== "string") return null
  return { name, email, password, rememberMe: rememberMe === false ? false : undefined }
}

function coreWouldReachDuplicate(ctx: GenericEndpointContext, password: string) {
  const { options, password: hashing } = ctx.context
  if (!options.emailAndPassword?.enabled || options.emailAndPassword.disableSignUp) return false
  const { minPasswordLength, maxPasswordLength } = hashing.config
  return password.length >= minPasswordLength && password.length <= maxPasswordLength
}

export function guestClaimHook(opts: ResolvedWaitlistOptions) {
  return {
    matcher: (ctx: { path?: string }) => ctx.path === SIGN_UP_PATH,
    handler: createAuthMiddleware(async (ctx) => {
      if (!opts.gate.enabled) return
      const body = signUpBody(ctx.body)
      if (!body || !coreWouldReachDuplicate(ctx, body.password)) return
      const email = body.email.toLowerCase()
      if (email !== normalizeEmail(email)) return
      const code = await presentedCode(ctx, opts)
      if (code === null) return
      const claimed = await claim(ctx, { ...body, email }, code)
      if (!claimed) return
      return respond(ctx, opts, claimed, body.rememberMe === false)
    }),
  }
}

async function claim(ctx: GenericEndpointContext, body: SignUpBody, code: string) {
  const { context } = ctx
  const found = await findUser(context, body.email)
  if (!found?.isGuest) return null
  const now = new Date()
  const entry = await findEntryByEmail(context, body.email)
  if (!entry || !(await liveInvite(entry, code, now))?.byCode) return null
  const hash = await context.password.hash(body.password)
  return inTransaction(context, async () => {
    const current = await findUser(context, body.email)
    if (!current?.isGuest || current.user.id !== found.user.id) return null
    if ((await inRealTransaction(context)) && !(await claimInvite(context, entry, now))) return null
    const issuer = "issuer" in (context.tables.account?.fields ?? {}) ? { issuer: "local:credential" } : {}
    await context.internalAdapter.linkAccount({
      ...issuer,
      userId: found.user.id,
      providerId: "credential",
      accountId: found.user.id,
      password: hash,
    } as Parameters<typeof context.internalAdapter.linkAccount>[0])
    const user = await context.internalAdapter.updateUser(found.user.id, { name: body.name, emailVerified: true })
    if (!user) throw APIError.from("UNPROCESSABLE_ENTITY", BASE_ERROR_CODES.FAILED_TO_UPDATE_USER)
    return user as User & Record<string, unknown>
  })
}

async function respond(
  ctx: GenericEndpointContext,
  opts: ResolvedWaitlistOptions,
  user: User & Record<string, unknown>,
  dontRememberMe: boolean
) {
  const { context } = ctx
  await createGate(opts, context).after(user, ctx)
  const { emailAndPassword } = context.options
  const output = parseUserOutput(context.options, user)
  if (emailAndPassword?.autoSignIn === false || emailAndPassword?.requireEmailVerification) {
    return ctx.json({ token: null, user: output })
  }
  const session = await context.internalAdapter.createSession(user.id, dontRememberMe)
  if (!session) return ctx.json({ token: null, user: output })
  await setSessionCookie(ctx, { session, user }, dontRememberMe)
  return ctx.json({ token: session.token, user: output })
}
