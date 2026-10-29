import type { GenericEndpointContext } from "@better-auth/core"
import { toPublicEntry } from "./entries"
import { hostScope, notifyHost } from "./host"
import type { ResolvedWaitlistOptions } from "./options"
import type { WaitlistEntryRow } from "./state-machine"
import { generateInvite } from "./tokens"

/** Why an invite was issued: the `reason` `sendInvite` receives. */
export type InviteReason = "approved" | "direct" | "resent" | "auto"

/** A freshly minted invite: the raw code, and the row fields that store it. */
export interface MintedInvite {
  code: string
  fields: { inviteCodeHash: string; inviteExpiresAt: Date | null; invitedAt: Date }
}

/** An invite whose hash was just written. The raw `code` exists only here and in what `deliverInvite` hands out. */
export interface IssuedInvite {
  entry: WaitlistEntryRow
  code: string
  reason: InviteReason
}

/**
 * Mint one invite: a CSPRNG base62 code of `invite.codeLength`, and the row
 * fields that store it (SHA-256 hash, expiry from `invite.expiresIn`, issue
 * time). Writing the fields replaces any earlier invite, so the old code stops
 * matching. Mint once per write path, so a retried write stores the code that
 * gets sent.
 */
export async function mintInvite(opts: ResolvedWaitlistOptions, now: Date): Promise<MintedInvite> {
  const { code, hash } = await generateInvite(opts.invite.codeLength)
  const { expiresIn } = opts.invite
  return {
    code,
    fields: {
      inviteCodeHash: hash,
      inviteExpiresAt: expiresIn === null ? null : new Date(now.getTime() + expiresIn * 1000),
      invitedAt: now,
    },
  }
}

/** The entry holds an invite that hasn't expired (`inviteExpiresAt` null: never expires). */
export const hasLiveInvite = (entry: WaitlistEntryRow, now: Date) =>
  entry.inviteCodeHash != null && (entry.inviteExpiresAt == null || entry.inviteExpiresAt.getTime() > now.getTime())

/** The row fields that clear the live invite (reject, requeue, register). */
export const clearedInvite = () => ({ inviteCodeHash: null, inviteExpiresAt: null })

/**
 * The one sink for issued invites: hands the invite to `sendInvite` (after the
 * write, through `runCallback`). Returns the raw code for the response when
 * `invite.returnCodeToManager` is on, else undefined.
 */
export async function deliverInvite(
  ctx: GenericEndpointContext,
  opts: ResolvedWaitlistOptions,
  issued: IssuedInvite
): Promise<string | undefined> {
  const { sendInvite } = opts
  const { buildUrl } = opts.invite
  if (sendInvite && buildUrl) {
    const { code, entry, reason } = issued
    await notifyHost({ ...hostScope(ctx, opts, [code]), name: "sendInvite" }, () =>
      sendInvite(
        {
          entry: toPublicEntry(entry),
          email: entry.email,
          code,
          url: buildUrl(code),
          expiresAt: entry.inviteExpiresAt ?? null,
          reason,
        },
        ctx.request
      )
    )
  }
  return opts.invite.returnCodeToManager ? issued.code : undefined
}
