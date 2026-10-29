import type { AuthContext, GenericEndpointContext } from "@better-auth/core"
import { createAuthEndpoint } from "better-auth/api"
import { type InferAdditionalFieldsFromPluginOptions, parseInputData, toZodSchema } from "better-auth/db"
import * as z from "zod/mini"
import {
  confirmEntry,
  countPending,
  findEntryById,
  findEntryByInviteHash,
  getPosition,
  getReferralCount,
  normalizeEmail,
} from "../entries"
import { waitlistError } from "../errors"
import { registerUser } from "../gate"
import { hostScope, inviteCookie, notifyHost, shouldAutoApprove } from "../host"
import { hasLiveInvite, mintInvite } from "../invites"
import { addToWaitlist, isFull, joinRefusal } from "../join"
import type { ResolvedWaitlistOptions, WaitlistOptions } from "../options"
import { claimReferral, referrerFor } from "../referrals"
import type { WaitlistEntryRow } from "../state-machine"
import { generateReferralCode, hashInviteCode, verifyStatusToken } from "../tokens"
import { findUser } from "../users"

const joinBodySchema = z.object({
  email: z.email().check(z.meta({ description: "The email to put on the waitlist" })),
  name: z.optional(z.string().check(z.maxLength(100), z.meta({ description: "Display name" }))),
  referralCode: z.optional(
    z
      .string()
      .check(z.meta({ description: "The referrer's referral code. An unknown code or a self-referral is ignored" }))
  ),
})

export const joinWaitlist = <O extends WaitlistOptions>(opts: ResolvedWaitlistOptions) => {
  const additionalFields = opts.schema?.waitlistEntry?.additionalFields ?? {}
  const body = z.object({
    ...joinBodySchema.shape,
    ...toZodSchema({ fields: additionalFields, isClientSide: true }).shape,
  })

  return createAuthEndpoint(
    "/waitlist/join",
    {
      method: "POST",
      body,
      metadata: {
        $Infer: {
          body: {} as z.infer<typeof joinBodySchema> & InferAdditionalFieldsFromPluginOptions<"waitlistEntry", O>,
        },
        openapi: {
          operationId: "joinWaitlist",
          description: "Join the waitlist. Always succeeds, whether or not the email is already on the list.",
          responses: {
            200: {
              description: "Success",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { success: { type: "boolean" } }, required: ["success"] },
                },
              },
            },
          },
        },
      },
    },
    async (ctx) => {
      const { context } = ctx
      const success = () => ctx.json({ success: true })

      const email = normalizeEmail(ctx.body.email)
      const name = ctx.body.name
      const question = { email, emailVerified: false, request: ctx.request }
      const refused = await joinRefusal(ctx, opts, { email, name, emailVerified: false })
      if (refused) throw waitlistError(refused)

      const now = new Date()
      const additional = parseInputData(ctx.body, { fields: additionalFields, action: "create" })
      const autoApprove = await shouldAutoApprove(hostScope(ctx, opts), question)
      const invite = autoApprove ? await mintInvite(opts, now) : null
      const referrer = await referrerFor(ctx, opts, email, ctx.body.referralCode)
      const patch = {
        ...additional,
        email,
        name,
        queueScore: now.getTime(),
        referralCode: generateReferralCode(),
        ...(referrer ? { referredById: referrer.id } : {}),
        ...(opts.sendStatusLink ? { lastNotifiedAt: now } : {}),
        ...invite?.fields,
      }

      if (await isFull(ctx, opts)) throw waitlistError("WAITLIST_FULL")

      const existing = await findUser(context, email)
      if (existing && !existing.isGuest) {
        const { onExistingUserJoin } = opts
        if (onExistingUserJoin) {
          await notifyHost({ ...hostScope(ctx, opts), name: "onExistingUserJoin" }, () =>
            onExistingUserJoin({ user: existing.user }, ctx.request)
          )
        }
        return success()
      }

      await addToWaitlist(ctx, opts, {
        email,
        now,
        event: autoApprove ? "autoApprove" : "join",
        patch,
        invite,
        reasons: { created: "joined", existing: "rejoined" },
        source: "join",
        referrer,
      })
      return success()
    }
  )
}

async function entryFromToken(context: AuthContext, token: string) {
  const entryId = await verifyStatusToken(token, context.secret)
  const entry = entryId ? await findEntryById(context, entryId) : null
  if (!entry) throw waitlistError("INVALID_STATUS_TOKEN")
  return entry
}

async function repairRegistration(ctx: GenericEndpointContext, opts: ResolvedWaitlistOptions, entry: WaitlistEntryRow) {
  if (entry.status !== "approved" || entry.inviteCodeHash != null) return entry
  const existing = await ctx.context.internalAdapter.findUserByEmail(entry.email)
  if (!existing) return entry
  await registerUser(ctx, opts, existing.user, { inboxProven: existing.user.emailVerified })
  return (await findEntryById(ctx.context, entry.id)) ?? entry
}

const tokenSchema = z.string().check(z.minLength(1), z.meta({ description: "The status token from the status link" }))

export const getWaitlistStatus = (opts: ResolvedWaitlistOptions) =>
  createAuthEndpoint(
    "/waitlist/status",
    {
      method: "GET",
      query: z.object({ token: tokenSchema }),
      metadata: {
        openapi: {
          operationId: "getWaitlistStatus",
          description: "Read an entry's status and queue position with its status token",
        },
      },
    },
    async (ctx) => {
      const { context } = ctx
      const entry = await repairRegistration(ctx, opts, await entryFromToken(context, ctx.query.token))
      await claimReferral(context, ctx, opts, entry)
      const [position, queueLength, referralCount] = await Promise.all([
        getPosition(context, entry),
        countPending(context),
        getReferralCount(context, entry.id),
      ])
      const invite =
        entry.status === "approved" && entry.inviteCodeHash != null
          ? {
              expiresAt: entry.inviteExpiresAt ?? null,
              expired: entry.inviteExpiresAt ? entry.inviteExpiresAt.getTime() <= Date.now() : false,
            }
          : null
      return ctx.json({
        email: entry.email,
        status: entry.status,
        position,
        queueLength,
        referralCode: entry.referralCode,
        referralCount,
        emailConfirmed: entry.emailConfirmed,
        invite,
      })
    }
  )

export const confirmWaitlistEntry = (opts: ResolvedWaitlistOptions) =>
  createAuthEndpoint(
    "/waitlist/confirm",
    {
      method: "POST",
      body: z.object({ token: tokenSchema }),
      metadata: {
        openapi: {
          operationId: "confirmWaitlistEntry",
          description: "Confirm the entry's inbox with its status token. Idempotent.",
        },
      },
    },
    async (ctx) => {
      const { context } = ctx
      const entry = await entryFromToken(context, ctx.body.token)
      const confirmed = (await confirmEntry(context, entry.id, new Date())) ?? entry
      await claimReferral(context, ctx, opts, confirmed)
      return ctx.json({ success: true })
    }
  )

/** What `/waitlist/invite/accept` answers: the invited email and expiry only for a valid code. */
export type AcceptInviteResult = { valid: true; email: string; expiresAt: Date | null } | { valid: false }

/**
 * The register page's first call: a valid code (its entry is
 * `approved` and the invite live) returns the invited email and expiry, and
 * sets the signed invite cookie that carries the code through OAuth and
 * magic-link redirects. Anything else is `{ valid: false }` and nothing more,
 * so the endpoint never shows an email to someone without the secret.
 */
export const acceptWaitlistInvite = (opts: ResolvedWaitlistOptions) =>
  createAuthEndpoint(
    "/waitlist/invite/accept",
    {
      method: "POST",
      body: z.object({
        code: z
          .string()
          .check(z.minLength(1), z.maxLength(256), z.meta({ description: "The invite code from the invite link" })),
      }),
      metadata: {
        openapi: {
          operationId: "acceptWaitlistInvite",
          description: "Check an invite code; when valid, return the invited email and set the invite cookie",
        },
      },
    },
    async (ctx) => {
      const { code } = ctx.body
      const entry = await findEntryByInviteHash(ctx.context, await hashInviteCode(code))
      if (entry?.status !== "approved" || !hasLiveInvite(entry, new Date())) {
        const invalid: AcceptInviteResult = { valid: false }
        return ctx.json(invalid)
      }
      const cookie = inviteCookie(ctx.context, opts)
      await ctx.setSignedCookie(cookie.name, code, ctx.context.secret, cookie.attributes)
      const valid: AcceptInviteResult = { valid: true, email: entry.email, expiresAt: entry.inviteExpiresAt ?? null }
      return ctx.json(valid)
    }
  )
