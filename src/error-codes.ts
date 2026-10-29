import { defineErrorCodes } from "@better-auth/core/utils/error-codes"

/**
 * Every error the plugin can return. Messages are short phrases
 * with no punctuation so they survive OAuth's `split(" ").join("_")` encoding.
 *
 * Shared by the server and `./client`, so this module imports nothing but
 * `defineErrorCodes`. The server's `APIError` helper is in `errors.ts`.
 */
export const WAITLIST_ERROR_CODES = defineErrorCodes({
  WAITLIST_INVITE_REQUIRED: "Waitlist invite required",
  INVALID_INVITE_CODE: "Invalid or expired invite code",
  WAITLIST_CLOSED: "Waitlist is closed",
  WAITLIST_FULL: "Waitlist is full",
  EMAIL_NOT_ALLOWED: "Email not allowed",
  INVALID_STATUS_TOKEN: "Invalid status link",
  INVALID_STATUS_TRANSITION: "Invalid waitlist status transition",
  ENTRY_NOT_FOUND: "Waitlist entry not found",
  NOT_ALLOWED_TO_MANAGE_WAITLIST: "Not allowed to manage the waitlist",
})

export type WaitlistErrorCode = keyof typeof WAITLIST_ERROR_CODES
