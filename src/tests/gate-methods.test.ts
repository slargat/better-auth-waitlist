import { oneTap } from "better-auth/plugins"
import { anonymous } from "better-auth/plugins/anonymous"
import { describe, expect, it } from "vite-plus/test"
import type { WaitlistOptions } from "../index"
import { googleIdToken, signInWithGoogle, useFakeGoogle } from "./google"
import {
  admit,
  cookiesFrom,
  createWaitlistInstance,
  entryOf,
  PASSWORD,
  rejectEntry,
  request,
  seedAccount,
  seedUser,
  signUpAdmitted,
  usersWith,
} from "./harness"

useFakeGoogle()

const ADMITTING = { invite: { returnCodeToManager: true } } satisfies WaitlistOptions
type Instance = Awaited<ReturnType<typeof createWaitlistInstance>>

const inviteCookieFor = async (instance: Instance, code: string) =>
  cookiesFrom(await request(instance, "/waitlist/invite/accept", { body: { code } }))

const errorOf = (res: Response) => new URL(res.headers.get("location") ?? "", "http://localhost:3000")

describe("gate: OAuth redirect (Google callback)", () => {
  it("refuses a new user with a redirect to errorCallbackURL carrying the code, and creates no user", async () => {
    const instance = await createWaitlistInstance(ADMITTING)

    const res = await signInWithGoogle(instance, { email: "ada@example.com" })

    expect(res.status).toBe(302)
    const location = errorOf(res)
    expect(location.pathname).toBe("/register")
    expect(location.searchParams.get("error")).toBe("WAITLIST_INVITE_REQUIRED")
    expect(await usersWith(instance.db, "ada@example.com")).toEqual([])
  })

  it("admits an invited user who opened the invite link (the cookie survives the redirect), and registers them", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const cookie = await inviteCookieFor(instance, await admit(instance, "ada@example.com"))

    const res = await signInWithGoogle(instance, { email: "ada@example.com" }, { cookie })

    expect(res.status).toBe(302)
    expect(errorOf(res).pathname).toBe("/dashboard")
    expect(await usersWith(instance.db, "ada@example.com")).toHaveLength(1)
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
    expect(res.headers.get("set-cookie")).toMatch(/better-auth\.waitlist_invite=; Max-Age=0/)
  })

  it("refuses with INVALID_INVITE_CODE when the Google account's email isn't the invited one", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const cookie = await inviteCookieFor(instance, await admit(instance, "ada@example.com"))

    const res = await signInWithGoogle(instance, { email: "someone-else@example.com" }, { cookie })

    expect(errorOf(res).searchParams.get("error")).toBe("INVALID_INVITE_CODE")
    expect(await usersWith(instance.db, "someone-else@example.com")).toEqual([])
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "approved" })
  })

  it("records an OAuth email the provider verified as confirmed on a registered entry's user", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const cookie = await inviteCookieFor(instance, await admit(instance, "ada@example.com"))

    await signInWithGoogle(instance, { email: "ada@example.com", emailVerified: true }, { cookie })

    expect(await usersWith(instance.db, "ada@example.com")).toMatchObject([{ emailVerified: true }])
  })
})

describe("gate: OAuth ID token (/sign-in/social)", () => {
  const signInWithIdToken = (instance: Instance, email: string, headers: Record<string, string> = {}) =>
    request(instance, "/sign-in/social", {
      body: { provider: "google", idToken: { token: googleIdToken({ email }) } },
      headers,
    })

  it("refuses a new user with a 403 JSON error carrying the code", async () => {
    const instance = await createWaitlistInstance(ADMITTING)

    const res = await signInWithIdToken(instance, "ada@example.com")

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "WAITLIST_INVITE_REQUIRED" })
    expect(await usersWith(instance.db, "ada@example.com")).toEqual([])
  })

  it("admits an invited user with the code", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const code = await admit(instance, "ada@example.com")

    const res = await signInWithIdToken(instance, "ada@example.com", { "x-waitlist-invite": code })

    expect(res.status).toBe(200)
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
  })
})

describe("gate: Google One Tap", () => {
  const oneTapSignIn = (instance: Instance, email: string, cookie?: string) =>
    request(instance, "/one-tap/callback", { body: { idToken: googleIdToken({ email }) }, cookie })

  it("refuses a new user with a 403 JSON error carrying the code, and admits one with the invite cookie", async () => {
    const instance = await createWaitlistInstance(ADMITTING, { plugins: [oneTap()] })
    const cookie = await inviteCookieFor(instance, await admit(instance, "ada@example.com"))

    const blocked = await oneTapSignIn(instance, "bob@example.com")
    const admitted = await oneTapSignIn(instance, "ada@example.com", cookie)

    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toMatchObject({ code: "WAITLIST_INVITE_REQUIRED" })
    expect(await usersWith(instance.db, "bob@example.com")).toEqual([])
    expect(admitted.status).toBe(200)
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
  })
})

describe("gate: magic link", () => {
  async function openMagicLink(instance: Instance, email: string, cookie?: string) {
    await request(instance, "/sign-in/magic-link", {
      body: { email, callbackURL: "/dashboard", errorCallbackURL: "/register" },
      cookie,
    })
    return request(instance, instance.outbox.magicLinkFor(email), { cookie })
  }

  it("sends the link to anyone (sending isn't gated, so it enumerates nobody)", async () => {
    const instance = await createWaitlistInstance(ADMITTING)

    const res = await request(instance, "/sign-in/magic-link", { body: { email: "ada@example.com" } })

    expect(res.status).toBe(200)
    expect(instance.outbox.magicLinkFor("ada@example.com")).toContain("/magic-link/verify")
  })

  it("refuses a new user with a redirect to errorCallbackURL carrying the code, and creates no user", async () => {
    const instance = await createWaitlistInstance(ADMITTING)

    const res = await openMagicLink(instance, "ada@example.com")

    expect(res.status).toBe(302)
    const location = errorOf(res)
    expect(location.pathname).toBe("/register")
    expect(location.searchParams.get("error")).toBe("WAITLIST_INVITE_REQUIRED")
    expect(await usersWith(instance.db, "ada@example.com")).toEqual([])
  })

  it("redirects a wrong code as INVALID_INVITE_CODE, and other errors as Better Auth names them", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    await admit(instance, "ada@example.com")
    await admit(instance, "bob@example.com")
    const bobsCookie = await inviteCookieFor(instance, await admit(instance, "carol@example.com"))

    const wrongCode = await openMagicLink(instance, "ada@example.com", bobsCookie)
    const badToken = await request(instance, "/magic-link/verify?token=nope&errorCallbackURL=/register")

    expect(errorOf(wrongCode).searchParams.get("error")).toBe("INVALID_INVITE_CODE")
    expect(errorOf(badToken).searchParams.get("error")).toBe("INVALID_TOKEN")
  })

  it("admits an invited user who opened the invite link first, and registers them", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const cookie = await inviteCookieFor(instance, await admit(instance, "ada@example.com"))

    const res = await openMagicLink(instance, "ada@example.com", cookie)

    expect(errorOf(res).pathname).toBe("/dashboard")
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
  })
})

describe("gate: email OTP", () => {
  async function signInWithOtp(instance: Instance, email: string, headers: Record<string, string> = {}) {
    await request(instance, "/email-otp/send-verification-otp", { body: { email, type: "sign-in" } })
    return request(instance, "/sign-in/email-otp", { body: { email, otp: instance.outbox.otpFor(email) }, headers })
  }

  it("sends the OTP to anyone, then refuses a new user with a 403 JSON error carrying the code", async () => {
    const instance = await createWaitlistInstance(ADMITTING)

    const res = await signInWithOtp(instance, "ada@example.com")

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "WAITLIST_INVITE_REQUIRED" })
    expect(await usersWith(instance.db, "ada@example.com")).toEqual([])
  })

  it("admits an invited user with the code", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const code = await admit(instance, "ada@example.com")

    const res = await signInWithOtp(instance, "ada@example.com", { "x-waitlist-invite": code })

    expect(res.status).toBe(200)
    expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
  })
})

describe("gate: anonymous", () => {
  it("refuses anonymous users by default (they have no entry)", async () => {
    const instance = await createWaitlistInstance({}, { plugins: [anonymous()] })

    const res = await request(instance, "/sign-in/anonymous", { method: "POST", body: {} })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "WAITLIST_INVITE_REQUIRED" })
  })

  it("lets them in through a host bypass", async () => {
    const instance = await createWaitlistInstance(
      { gate: { bypass: ({ ctx }) => ctx?.path === "/sign-in/anonymous" } },
      { plugins: [anonymous()] }
    )

    const res = await request(instance, "/sign-in/anonymous", { method: "POST", body: {} })

    expect(res.status).toBe(200)
  })
})

describe("sign-in is never blocked", () => {
  async function withUsers() {
    const instance = await createWaitlistInstance(ADMITTING)
    await seedUser(instance, "before@example.com", { password: PASSWORD, google: "google-before@example.com" })
    await seedUser(instance, "no-entry@example.com", { password: PASSWORD, google: "google-no-entry@example.com" })
    await admit(instance, "before@example.com")
    await rejectEntry(instance, "before@example.com")
    const member = await signUpAdmitted(instance, "member@example.com")
    await seedAccount(instance, member.id, "google", "google-member@example.com")
    return instance
  }
  const EMAILS = ["no-entry@example.com", "before@example.com", "member@example.com"]

  it.each(EMAILS)("%s signs in with a password", async (email) => {
    const instance = await withUsers()

    const res = await request(instance, "/sign-in/email", { body: { email, password: PASSWORD } })

    expect(res.status).toBe(200)
  })

  it.each(EMAILS)("%s signs in with Google", async (email) => {
    const instance = await withUsers()

    const res = await signInWithGoogle(instance, { email, emailVerified: true })

    expect(errorOf(res).pathname).toBe("/dashboard")
    expect(await usersWith(instance.db, email)).toHaveLength(1)
  })

  it.each(EMAILS)("%s signs in with a Google ID token", async (email) => {
    const instance = await withUsers()

    const res = await request(instance, "/sign-in/social", {
      body: { provider: "google", idToken: { token: googleIdToken({ email }) } },
    })

    expect(res.status).toBe(200)
  })

  it.each(EMAILS)("%s signs in with a magic link", async (email) => {
    const instance = await withUsers()
    await request(instance, "/sign-in/magic-link", { body: { email, callbackURL: "/dashboard" } })

    const res = await request(instance, instance.outbox.magicLinkFor(email))

    expect(errorOf(res).pathname).toBe("/dashboard")
  })

  it.each(EMAILS)("%s signs in with an email OTP", async (email) => {
    const instance = await withUsers()
    await request(instance, "/email-otp/send-verification-otp", { body: { email, type: "sign-in" } })

    const res = await request(instance, "/sign-in/email-otp", { body: { email, otp: instance.outbox.otpFor(email) } })

    expect(res.status).toBe(200)
  })
})
