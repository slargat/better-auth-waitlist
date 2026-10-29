import { APIError } from "@better-auth/core/error"
import { WAITLIST_ERROR_CODES, type WaitlistErrorCode } from "./error-codes"

const ERROR_STATUS = {
  WAITLIST_INVITE_REQUIRED: "FORBIDDEN",
  INVALID_INVITE_CODE: "FORBIDDEN",
  WAITLIST_CLOSED: "FORBIDDEN",
  WAITLIST_FULL: "FORBIDDEN",
  EMAIL_NOT_ALLOWED: "BAD_REQUEST",
  INVALID_STATUS_TOKEN: "BAD_REQUEST",
  INVALID_STATUS_TRANSITION: "CONFLICT",
  ENTRY_NOT_FOUND: "NOT_FOUND",
  NOT_ALLOWED_TO_MANAGE_WAITLIST: "FORBIDDEN",
} as const satisfies Record<WaitlistErrorCode, ConstructorParameters<typeof APIError>[0]>

/**
 * Build the `APIError` for a waitlist error code, with the HTTP status it pairs
 * it with. Always throw through this, so a code can't drift from its status.
 */
export function waitlistError(code: WaitlistErrorCode): APIError {
  return APIError.from(ERROR_STATUS[code], WAITLIST_ERROR_CODES[code])
}
