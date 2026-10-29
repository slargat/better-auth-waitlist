import { describe, expect, it } from "vite-plus/test"
import type { WaitlistOptions } from "../index"
import { admit, cookiesFrom, createWaitlistInstance, entryOf, PASSWORD, request, seedUser, usersWith } from "./harness"

const ADMITTING = { invite: { returnCodeToManager: true } } satisfies WaitlistOptions
const EMAIL = "guest@example.com"

type Instance = Awaited<ReturnType<typeof createWaitlistInstance<typeof ADMITTING>>>

const signUp = (instance: Instance, headers: Record<string, string> = {}, password = PASSWORD) =>
  instance.client.signUp.email({ email: EMAIL, password, name: "Ada Guest" }, { headers })

async function accountsOf(instance: Instance, password = PASSWORD) {
  const signIn = await request(instance, "/sign-in/email", { body: { email: EMAIL, password } })
  if (signIn.status !== 200) return []
  const accounts = await request(instance, "/list-accounts", { cookie: cookiesFrom(signIn) })
  return (await accounts.json()) as { providerId: string; accountId: string }[]
}

export function defineGuestClaimCases(testWith: "sqlite" | "postgres") {
  const create = (options: WaitlistOptions = ADMITTING, auth = {}) =>
    createWaitlistInstance({ ...ADMITTING, ...options }, { testWith, auth }) as Promise<Instance>

  describe("sign-up: an admitted Guest", () => {
    it("claims their existing user row with the invite code: a credential account and a session", async () => {
      const instance = await create()
      const guest = await seedUser(instance, EMAIL)
      const code = await admit(instance, EMAIL)

      const res = await signUp(instance, { "x-waitlist-invite": code })

      expect(res.error).toBeNull()
      expect(res.data?.user).toMatchObject({ id: guest.id, email: EMAIL, name: "Ada Guest", emailVerified: true })
      expect(res.data?.token).toEqual(expect.any(String))
      expect(await usersWith(instance.db, EMAIL)).toHaveLength(1)
      expect(await accountsOf(instance)).toEqual([
        expect.objectContaining({ providerId: "credential", accountId: guest.id }),
      ])
      expect(await entryOf(instance, EMAIL)).toMatchObject({ status: "registered", userId: guest.id })
      const signIn = await instance.client.signIn.email({ email: EMAIL, password: PASSWORD })
      expect(signIn.data?.user.id).toBe(guest.id)
    })

    it("signs the Guest in: the response's session cookie reads back as their user", async () => {
      const instance = await create()
      const guest = await seedUser(instance, EMAIL)
      const code = await admit(instance, EMAIL)

      const res = await request(instance, "/sign-up/email", {
        body: { email: EMAIL, password: PASSWORD, name: "Ada Guest" },
        headers: { "x-waitlist-invite": code },
      })
      const session = await request(instance, "/get-session", { cookie: cookiesFrom(res) })

      expect(res.status).toBe(200)
      expect((await session.json())?.user?.id).toBe(guest.id)
    })

    it("can't claim twice with the same invite code", async () => {
      const instance = await create()
      await seedUser(instance, EMAIL)
      const code = await admit(instance, EMAIL)
      await signUp(instance, { "x-waitlist-invite": code })

      const again = await signUp(instance, { "x-waitlist-invite": code }, "another-password")

      expect(again.error?.status).toBe(422)
      expect(await accountsOf(instance)).toHaveLength(1)
      expect(await accountsOf(instance, "another-password")).toEqual([])
    })
  })

  describe("sign-up: a Guest's claim whose user update fails", () => {
    it("fails, and attaches no account (a host refuses the update)", async () => {
      const refuseUserUpdates = { user: { update: { before: async () => false } } }
      const instance = await create(ADMITTING, { databaseHooks: refuseUserUpdates })
      await seedUser(instance, EMAIL)
      const code = await admit(instance, EMAIL)

      const res = await signUp(instance, { "x-waitlist-invite": code })

      expect(res.error?.code).toBe("FAILED_TO_UPDATE_USER")
      const signIn = await instance.client.signIn.email({ email: EMAIL, password: PASSWORD })
      expect(signIn.error?.status).toBe(401)
      expect(await entryOf(instance, EMAIL)).toMatchObject({ status: "approved" })
    })
  })

  for (const gate of [{ enabled: true }, { enabled: false }]) {
    describe(`sign-up: a Guest without a valid invite (gate ${gate.enabled ? "on" : "off"})`, () => {
      it("is refused as an existing email, with no account attached", async () => {
        const instance = await create({ gate })
        await seedUser(instance, EMAIL)

        const res = await signUp(instance)

        expect(res.error).toMatchObject({ status: 422, code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" })
        expect(await accountsOf(instance)).toEqual([])
      })

      it("is refused with a wrong code, with no account attached", async () => {
        const instance = await create({ gate })
        await seedUser(instance, EMAIL)
        await admit(instance, EMAIL)

        const res = await signUp(instance, { "x-waitlist-invite": "not-the-code" })

        expect(res.error).toMatchObject({ status: 422, code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" })
        expect(await accountsOf(instance)).toEqual([])
      })

      it("is refused with another email's code", async () => {
        const instance = await create({ gate })
        await seedUser(instance, EMAIL)
        const otherCode = await admit(instance, "other@example.com")

        const res = await signUp(instance, { "x-waitlist-invite": otherCode })

        expect(res.error?.status).toBe(422)
        expect(await accountsOf(instance)).toEqual([])
      })
    })
  }

  describe("sign-up: a Guest's claim answers like core's sign-up of a new email", () => {
    const LIMITS = { enabled: true, minPasswordLength: 10, maxPasswordLength: 20 }
    it.each([
      ["a password one short of the minimum", LIMITS, "x".repeat(9)],
      ["a password at the minimum", LIMITS, "x".repeat(10)],
      ["a password at the maximum", LIMITS, "x".repeat(20)],
      ["a password one over the maximum", LIMITS, "x".repeat(21)],
      ["sign-up disabled", { ...LIMITS, disableSignUp: true }, "x".repeat(12)],
    ])("%s", async (_, emailAndPassword, password) => {
      const instance = await create(ADMITTING, { emailAndPassword })
      await seedUser(instance, EMAIL)
      const guestCode = await admit(instance, EMAIL)
      const newCode = await admit(instance, "new@example.com")
      const outcome = (res: { error: { status: number; code?: string } | null }) =>
        res.error ? { status: res.error.status, code: res.error.code } : { status: 200 }

      const guest = await signUp(instance, { "x-waitlist-invite": guestCode }, password)
      const fresh = await instance.client.signUp.email(
        { email: "new@example.com", password, name: "New" },
        { headers: { "x-waitlist-invite": newCode } }
      )

      expect(outcome(guest)).toEqual(outcome(fresh))
    })
  })

  describe("sign-up: the gate off", () => {
    it("never claims, even with the entry's own invite code", async () => {
      const instance = await create({ gate: { enabled: false } })
      await seedUser(instance, EMAIL)
      const code = await admit(instance, EMAIL)

      const res = await signUp(instance, { "x-waitlist-invite": code })

      expect(res.error).toMatchObject({ status: 422, code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" })
      expect(await accountsOf(instance)).toEqual([])
    })
  })

  describe("sign-up: an account holder with an invite code", () => {
    it("is refused as an existing email, and their password is unchanged", async () => {
      const instance = await create()
      await seedUser(instance, EMAIL, { password: PASSWORD })
      const code = await admit(instance, EMAIL)

      const res = await signUp(instance, { "x-waitlist-invite": code }, "another-password")

      expect(res.error?.status).toBe(422)
      const signIn = await instance.client.signIn.email({ email: EMAIL, password: PASSWORD })
      expect(signIn.error).toBeNull()
    })
  })
}
