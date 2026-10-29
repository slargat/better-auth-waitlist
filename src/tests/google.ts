import { createSign, generateKeyPairSync } from "node:crypto"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll } from "vite-plus/test"
import { cookiesFrom, request } from "./harness"

const KID = "waitlist-test-key"
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url")

export interface GoogleUser {
  email: string
  sub?: string
  emailVerified?: boolean
}

export function googleIdToken(user: GoogleUser) {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }))
  const payload = base64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      aud: "test",
      sub: user.sub ?? `google-${user.email}`,
      email: user.email,
      email_verified: user.emailVerified ?? true,
      name: user.email,
      iat: now,
      exp: now + 600,
    })
  )
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey)
  return `${header}.${payload}.${base64url(signature)}`
}

let nextUser: GoogleUser | null = null

const server = setupServer(
  http.get("https://www.googleapis.com/oauth2/v3/certs", () => HttpResponse.json({ keys: [jwk] })),
  http.post("https://oauth2.googleapis.com/token", () => {
    if (!nextUser) return HttpResponse.json({ error: "invalid_grant" }, { status: 400 })
    return HttpResponse.json({
      access_token: "google-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid email profile",
      id_token: googleIdToken(nextUser),
    })
  })
)

export function useFakeGoogle() {
  beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }))
  afterEach(() => {
    nextUser = null
  })
  afterAll(() => server.close())
}

type HandlerInstance = Parameters<typeof request>[0]

export async function signInWithGoogle(
  instance: HandlerInstance,
  user: GoogleUser,
  { cookie = "" }: { cookie?: string } = {}
) {
  const start = await request(instance, "/sign-in/social", {
    body: { provider: "google", callbackURL: "/dashboard", errorCallbackURL: "/register" },
    cookie,
  })
  const { url } = (await start.json()) as { url: string }
  const state = new URL(url).searchParams.get("state")
  if (!state) throw new Error("No OAuth state in the authorization URL")
  nextUser = user
  return request(instance, `/callback/google?code=fake-code&state=${encodeURIComponent(state)}`, {
    cookie: cookiesFrom(start, cookie),
  })
}
