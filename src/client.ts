import type { BetterAuthClientPlugin } from "@better-auth/core"
import type { DBFieldAttribute } from "@better-auth/core/db"
import { WAITLIST_ERROR_CODES } from "./error-codes"
import type { waitlist } from "./index"
import { getRedirectError, isWaitlistError } from "./redirect-errors"
import { PACKAGE_VERSION } from "./version"

export { WAITLIST_ERROR_CODES, type WaitlistErrorCode } from "./error-codes"
export { getRedirectError, isWaitlistError, type WaitlistRedirectError } from "./redirect-errors"
export type { WaitlistEntry, WaitlistStatus } from "./schema"

/**
 * Client-side options. They only shape types: pass the same
 * `schema.waitlistEntry.additionalFields` as the server so `join` takes them.
 */
export interface WaitlistClientOptions {
  schema?: {
    waitlistEntry?: {
      additionalFields?: Record<string, DBFieldAttribute>
    }
  }
}

/**
 * Client counterpart of the `waitlist` server plugin.
 * Endpoints are inferred through `$InferServerPlugin`; `pathMethods` pins every
 * mutation to POST. `authClient.waitlist.getRedirectError` and
 * `.isWaitlistError` are pure helpers that never fetch. No atoms, so nothing
 * fires a manager request on its own.
 */
export const waitlistClient = <O extends WaitlistClientOptions = Record<never, never>>(_options?: O) =>
  ({
    id: "waitlist",
    version: PACKAGE_VERSION,
    $InferServerPlugin: {} as ReturnType<typeof waitlist<{ schema: O["schema"] }>>,
    pathMethods: {
      "/waitlist/join": "POST",
      "/waitlist/confirm": "POST",
      "/waitlist/invite/accept": "POST",
      "/waitlist/admin/approve": "POST",
      "/waitlist/admin/reject": "POST",
      "/waitlist/admin/requeue": "POST",
      "/waitlist/admin/resend-invite": "POST",
      "/waitlist/admin/invite": "POST",
      "/waitlist/admin/boost": "POST",
      "/waitlist/admin/delete": "POST",
    },
    $ERROR_CODES: WAITLIST_ERROR_CODES,
    getActions: () => ({ waitlist: { getRedirectError, isWaitlistError } }),
  }) satisfies BetterAuthClientPlugin
