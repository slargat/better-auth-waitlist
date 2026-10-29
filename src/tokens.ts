import { constantTimeEqual, generateRandomString, makeSignature } from "better-auth/crypto"

const STATUS_TOKEN_PURPOSE = "better-auth-waitlist:status:"

const toBase64Url = (base64: string) => base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")

const signEntryId = async (entryId: string, secret: string) =>
  toBase64Url(await makeSignature(STATUS_TOKEN_PURPOSE + entryId, secret))

/**
 * The status token: `<entryId>.<base64url(HMAC-SHA256(secret, purpose + entryId))>`.
 * Stateless, re-sendable without rotation, invalidated only by rotating `secret`.
 */
export async function createStatusToken(entryId: string, secret: string): Promise<string> {
  return `${entryId}.${await signEntryId(entryId, secret)}`
}

/** The entry id a status token proves, or null. Compares in constant time. */
export async function verifyStatusToken(token: string, secret: string): Promise<string | null> {
  const dot = token.lastIndexOf(".")
  if (dot <= 0) return null
  const entryId = token.slice(0, dot)
  const expected = await signEntryId(entryId, secret)
  return constantTimeEqual(token.slice(dot + 1), expected) ? entryId : null
}

/** Public, short, unique per entry: 8 chars of `a-z0-9`. */
export const generateReferralCode = () => generateRandomString(8, "a-z", "0-9")

export const hashInviteCode = async (code: string) => sha256Hex(code)

/** True when `code` hashes to `hash`. Compares in constant time. */
export async function inviteCodeMatches(code: string, hash: string) {
  return constantTimeEqual(await sha256Hex(code), hash)
}

const sha256Hex = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * A new invite: a CSPRNG base62 code and its SHA-256 hex hash. Only the hash is
 * stored; the raw code exists only in what the plugin hands to `sendInvite`.
 */
export async function generateInvite(length: number) {
  const code = generateRandomString(length, "a-z", "A-Z", "0-9")
  return { code, hash: await sha256Hex(code) }
}
