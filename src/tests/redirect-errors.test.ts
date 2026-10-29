import { describe, expect, it } from "vite-plus/test"
import { getRedirectError, isWaitlistError, type WaitlistRedirectError } from "../client"
import type { WaitlistOptions } from "../index"
import { signInWithGoogle, useFakeGoogle } from "./google"
import { admit, cookiesFrom, createWaitlistInstance, request } from "./harness"

useFakeGoogle()

const ADMITTING = { invite: { returnCodeToManager: true } } satisfies WaitlistOptions
type Instance = Awaited<ReturnType<typeof createWaitlistInstance>>

function landing(res: Response) {
  expect(res.status).toBe(302)
  return new URL(res.headers.get("location") ?? "", "http://localhost:3000")
}

const inviteCookieFor = async (instance: Instance, code: string) =>
  cookiesFrom(await request(instance, "/waitlist/invite/accept", { body: { code } }))

async function openMagicLink(instance: Instance, email: string, cookie?: string) {
  await request(instance, "/sign-in/magic-link", {
    body: { email, callbackURL: "/dashboard", errorCallbackURL: "/register" },
    cookie,
  })
  return request(instance, instance.outbox.magicLinkFor(email), { cookie })
}

const REFUSED: Record<"OAuth callback" | "magic-link verify", Record<WaitlistRedirectError, () => Promise<URL>>> = {
  "OAuth callback": {
    async WAITLIST_INVITE_REQUIRED() {
      const instance = await createWaitlistInstance(ADMITTING)
      return landing(await signInWithGoogle(instance, { email: "ada@example.com" }))
    },
    async INVALID_INVITE_CODE() {
      const instance = await createWaitlistInstance(ADMITTING)
      const cookie = await inviteCookieFor(instance, await admit(instance, "ada@example.com"))
      return landing(await signInWithGoogle(instance, { email: "someone-else@example.com" }, { cookie }))
    },
  },
  "magic-link verify": {
    async WAITLIST_INVITE_REQUIRED() {
      const instance = await createWaitlistInstance(ADMITTING)
      return landing(await openMagicLink(instance, "ada@example.com"))
    },
    async INVALID_INVITE_CODE() {
      const instance = await createWaitlistInstance(ADMITTING)
      await admit(instance, "ada@example.com")
      const bobsCookie = await inviteCookieFor(instance, await admit(instance, "bob@example.com"))
      return landing(await openMagicLink(instance, "ada@example.com", bobsCookie))
    },
  },
}

const withError = (params: URLSearchParams, error: string) => {
  const copy = new URLSearchParams(params)
  copy.set("error", error)
  return copy
}

const underscored = (message: string) => message.split(" ").join("_")

describe.each(Object.entries(REFUSED))("getRedirectError: a refused sign-up through the %s", (_, byCode) => {
  describe.each(Object.entries(byCode))("%s", (code, refuse) => {
    it("is read from the real redirect, as a search string, a whole URL or URLSearchParams", async () => {
      const url = await refuse()

      expect(url.pathname).toBe("/register")
      expect(url.searchParams.get("error")).toBe(code)
      expect(getRedirectError(url.search)).toBe(code)
      expect(getRedirectError(url.search.slice(1))).toBe(code)
      expect(getRedirectError(url.href)).toBe(code)
      expect(getRedirectError(url.searchParams)).toBe(code)
    })

    it("matches the underscored message the redirect describes the error with, too", async () => {
      const url = await refuse()
      const description = url.searchParams.get("error_description")
      expect(description).toBeTruthy()
      const encoded = withError(url.searchParams, underscored(description ?? ""))

      expect(getRedirectError(encoded)).toBe(code)
      expect(getRedirectError(`?${encoded}`)).toBe(code)
    })

    it("ignores case, in either encoding", async () => {
      const url = await refuse()
      const message = underscored(url.searchParams.get("error_description") ?? "")

      for (const error of [code.toLowerCase(), message.toUpperCase(), message.toLowerCase()]) {
        expect(getRedirectError(withError(url.searchParams, error))).toBe(code)
        expect(getRedirectError(`?${withError(url.searchParams, error)}`)).toBe(code)
      }
    })
  })
})

describe("getRedirectError: hash routes", () => {
  it("reads a hash route's query when the main query has no error", async () => {
    const url = await REFUSED["magic-link verify"].INVALID_INVITE_CODE()
    const hashRoute = `#/register${url.search}`

    expect(getRedirectError(hashRoute)).toBe("INVALID_INVITE_CODE")
    expect(getRedirectError(`?a=1${hashRoute}`)).toBe("INVALID_INVITE_CODE")
    expect(getRedirectError(`https://app.test/?a=1${hashRoute}`)).toBe("INVALID_INVITE_CODE")
    expect(getRedirectError(`https://app.test/${hashRoute}`)).toBe("INVALID_INVITE_CODE")
  })

  it("lets the main query win over the hash route's", () => {
    const hashRoute = "#/register?error=INVALID_INVITE_CODE"

    expect(getRedirectError(`?error=WAITLIST_INVITE_REQUIRED${hashRoute}`)).toBe("WAITLIST_INVITE_REQUIRED")
    expect(getRedirectError(`?error=INVALID_TOKEN${hashRoute}`)).toBeNull()
    expect(getRedirectError(`https://app.test/register?error=INVALID_TOKEN${hashRoute}`)).toBeNull()
  })

  it("ignores a hash with no query, and a plain fragment", () => {
    expect(getRedirectError("?error=INVALID_INVITE_CODE#top")).toBe("INVALID_INVITE_CODE")
    expect(getRedirectError("#error=INVALID_INVITE_CODE")).toBeNull()
  })
})

describe("getRedirectError: anything else is null", () => {
  it("returns null for Better Auth's own redirect errors (a bad magic-link token, an OAuth callback with no state)", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const badToken = landing(await request(instance, "/magic-link/verify?token=nope&errorCallbackURL=/register"))
    const noState = landing(await request(instance, "/callback/google?code=fake-code"))

    expect(badToken.searchParams.get("error")).toBe("INVALID_TOKEN")
    expect(noState.searchParams.get("error")).toBe("state_not_found")
    for (const url of [badToken, noState]) {
      expect(getRedirectError(url.search)).toBeNull()
      expect(getRedirectError(url.searchParams)).toBeNull()
    }
  })

  it("returns null for the other waitlist codes, a successful return, and no error at all", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const cookie = await inviteCookieFor(instance, await admit(instance, "ada@example.com"))
    const admitted = landing(await openMagicLink(instance, "ada@example.com", cookie))

    expect(admitted.pathname).toBe("/dashboard")
    expect(getRedirectError(admitted.search)).toBeNull()
    expect(getRedirectError("")).toBeNull()
    expect(getRedirectError(new URLSearchParams())).toBeNull()
    expect(getRedirectError("?error=")).toBeNull()
    expect(getRedirectError("?error=WAITLIST_FULL")).toBeNull()
    expect(getRedirectError("?error=Waitlist_is_full")).toBeNull()
    expect(getRedirectError(new URLSearchParams({ error: "Waitlist invite required" }))).toBeNull()
    expect(getRedirectError("?error_description=WAITLIST_INVITE_REQUIRED")).toBeNull()
  })
})

describe("isWaitlistError", () => {
  it("narrows the JSON error of a refused sign-up the server sends", async () => {
    const instance = await createWaitlistInstance(ADMITTING)

    const res = await instance.client.signUp.email({ email: "ada@example.com", password: "password1234", name: "Ada" })

    expect(res.error).toMatchObject({ status: 403, code: "WAITLIST_INVITE_REQUIRED" })
    expect(isWaitlistError(res.error)).toBe(true)
  })

  it("is false for Better Auth's own codes, a missing code, and anything that isn't an error object", async () => {
    const instance = await createWaitlistInstance(ADMITTING)
    const wrongPassword = await instance.client.signIn.email({ email: "nobody@example.com", password: "password1234" })

    expect(wrongPassword.error?.code).toBe("INVALID_EMAIL_OR_PASSWORD")
    for (const error of [
      wrongPassword.error,
      { code: "waitlist_invite_required" },
      { code: "toString" },
      { code: "constructor" },
      { message: "Waitlist invite required" },
      { code: 403 },
      "WAITLIST_INVITE_REQUIRED",
      null,
      undefined,
    ]) {
      expect(isWaitlistError(error)).toBe(false)
    }
  })
})
