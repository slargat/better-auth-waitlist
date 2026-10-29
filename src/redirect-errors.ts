import { WAITLIST_ERROR_CODES, type WaitlistErrorCode } from "./error-codes"

const REDIRECT_ERRORS = [
  "WAITLIST_INVITE_REQUIRED",
  "INVALID_INVITE_CODE",
] as const satisfies readonly WaitlistErrorCode[]

/** The gate codes a sign-up refused during an OAuth or magic-link redirect comes back with. */
export type WaitlistRedirectError = (typeof REDIRECT_ERRORS)[number]

const ENCODINGS = new Map<string, WaitlistRedirectError>(
  REDIRECT_ERRORS.flatMap((code) => [
    [code.toLowerCase(), code],
    [WAITLIST_ERROR_CODES[code].message.split(" ").join("_").toLowerCase(), code],
  ])
)

const CODES = new Set<string>(Object.keys(WAITLIST_ERROR_CODES))

/**
 * The waitlist gate code in an OAuth or magic-link return URL's `error` param,
 * or null when there is none or it's another error. Takes the search string
 * (`location.search`, with or without `?`), a whole URL, or `URLSearchParams`.
 * Doesn't fetch.
 *
 * With a hash route (`#/register?error=...`), the query before `#` wins: the
 * hash's query is read only when the main query has no `error`.
 */
export function getRedirectError(search: string | URLSearchParams): WaitlistRedirectError | null {
  const error = typeof search === "string" ? errorParamOf(search) : search.get("error")
  return error === null ? null : (ENCODINGS.get(error.toLowerCase()) ?? null)
}

function errorParamOf(value: string): string | null {
  const hashAt = value.indexOf("#")
  const main = hashAt === -1 ? value : value.slice(0, hashAt)
  const fromMain = new URLSearchParams(main.slice(main.indexOf("?") + 1)).get("error")
  if (fromMain !== null || hashAt === -1) return fromMain
  const hash = value.slice(hashAt + 1)
  const queryAt = hash.indexOf("?")
  return queryAt === -1 ? null : new URLSearchParams(hash.slice(queryAt + 1)).get("error")
}

/**
 * True when `error` carries one of the waitlist error codes, narrowing its
 * `code` (for example the `error` of an `authClient.waitlist.*` call).
 */
export function isWaitlistError<E>(error: E): error is E & { code: WaitlistErrorCode } {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  const { code } = error
  return typeof code === "string" && CODES.has(code)
}
