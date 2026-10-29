import { describe, expect, it } from "vite-plus/test"
import type { WaitlistOptions } from "../index"
import { admit, createWaitlistInstance, entryOf, PASSWORD, request, seedUser } from "./harness"

const ADMITTING = { invite: { returnCodeToManager: true } } satisfies WaitlistOptions
const NEW_PASSWORD = "new-password-1234"

type Instance = Awaited<ReturnType<typeof createWaitlistInstance>>

export function defineResetCases(testWith: "sqlite" | "postgres") {
  async function resetInstance(options: WaitlistOptions = ADMITTING) {
    const resetMails: { email: string; token: string }[] = []
    const instance = await createWaitlistInstance(options, {
      testWith,
      auth: {
        emailAndPassword: {
          enabled: true,
          sendResetPassword: async ({ user, token }) => void resetMails.push({ email: user.email, token }),
        },
      },
    })
    return { ...instance, resetMails }
  }

  const requestReset = async (instance: Instance, email: string) => {
    const res = await request(instance, "/request-password-reset", { body: { email } })
    return { status: res.status, body: await res.json() }
  }

  const resetPassword = (instance: Instance, token: string) =>
    request(instance, "/reset-password", { body: { token, newPassword: NEW_PASSWORD } })

  const signIn = (instance: Instance, email: string) =>
    request(instance, "/sign-in/email", { body: { email, password: NEW_PASSWORD } })

  const credentialAccounts = (instance: Instance, userId: string) =>
    instance.db.findMany({
      model: "account",
      where: [
        { field: "userId", value: userId },
        { field: "providerId", value: "credential" },
      ],
    })

  async function issuedResetToken(instance: Instance, userId: string) {
    const token = `pre-guard-token-${userId}`
    const now = new Date()
    await instance.db.create({
      model: "verification",
      data: {
        identifier: `reset-password:${token}`,
        value: userId,
        expiresAt: new Date(now.getTime() + 3_600_000),
        createdAt: now,
        updatedAt: now,
      },
    })
    return token
  }

  describe(`password reset, gate on, unadmitted Guest (${testWith})`, () => {
    it("sends no reset mail, with the same response as an account holder and an unknown email", async () => {
      const instance = await resetInstance()
      await seedUser(instance, "guest@example.com")
      await seedUser(instance, "holder@example.com", { password: PASSWORD })

      const guest = await requestReset(instance, "guest@example.com")
      const holder = await requestReset(instance, "holder@example.com")
      const unknown = await requestReset(instance, "nobody@example.com")

      expect(guest).toEqual(holder)
      expect(unknown).toEqual(holder)
      expect(instance.resetMails.map((mail) => mail.email)).toEqual(["holder@example.com"])
    })

    it("asks join.autoApprove once for every email, whatever its user, account or entry", async () => {
      const asked: string[] = []
      const instance = await resetInstance({
        ...ADMITTING,
        join: {
          autoApprove: ({ email }) => {
            asked.push(email)
            return false
          },
        },
      })
      await seedUser(instance, "guest@example.com")
      await seedUser(instance, "listed-guest@example.com")
      await instance.client.waitlist.join({ email: "listed-guest@example.com" })
      await seedUser(instance, "holder@example.com", { password: PASSWORD })
      asked.length = 0

      const emails = ["guest@example.com", "listed-guest@example.com", "holder@example.com", "nobody@example.com"]
      for (const email of emails) await requestReset(instance, email)

      expect(asked).toEqual(emails)
    })

    it("refuses a reset token issued before the guard, and attaches no credential account", async () => {
      const instance = await resetInstance()
      const guest = await seedUser(instance, "guest@example.com")
      const token = await issuedResetToken(instance, guest.id)

      const res = await resetPassword(instance, token)

      expect(res.status).toBe(403)
      expect(await credentialAccounts(instance, guest.id)).toEqual([])
      expect((await signIn(instance, "guest@example.com")).status).toBe(401)
    })

    it("still resets an account holder's password", async () => {
      const instance = await resetInstance()
      await seedUser(instance, "holder@example.com", { password: PASSWORD })
      await requestReset(instance, "holder@example.com")

      const res = await resetPassword(instance, instance.resetMails[0]?.token ?? "")

      expect(res.status).toBe(200)
      expect((await signIn(instance, "holder@example.com")).status).toBe(200)
    })
  })

  describe(`password reset, admitted Guest or gate off (${testWith})`, () => {
    it("lets an admitted Guest reset, which gives them a login and registers their entry", async () => {
      const instance = await resetInstance()
      const guest = await seedUser(instance, "guest@example.com")
      await admit(instance, "guest@example.com")
      await requestReset(instance, "guest@example.com")

      const res = await resetPassword(instance, instance.resetMails[0]?.token ?? "")

      expect(res.status).toBe(200)
      expect(await credentialAccounts(instance, guest.id)).toHaveLength(1)
      expect((await signIn(instance, "guest@example.com")).status).toBe(200)
      expect(await entryOf(instance, "guest@example.com")).toMatchObject({ status: "registered", userId: guest.id })
    })

    it("lets a Guest reset with the gate off: their supported way to get a login", async () => {
      const instance = await resetInstance({ ...ADMITTING, gate: { enabled: false } })
      const guest = await seedUser(instance, "guest@example.com")
      await requestReset(instance, "guest@example.com")

      const res = await resetPassword(instance, instance.resetMails[0]?.token ?? "")

      expect(res.status).toBe(200)
      expect(await credentialAccounts(instance, guest.id)).toHaveLength(1)
      expect((await signIn(instance, "guest@example.com")).status).toBe(200)
    })

    it("accepts a pre-guard token with the gate off", async () => {
      const instance = await resetInstance({ ...ADMITTING, gate: { enabled: false } })
      const guest = await seedUser(instance, "guest@example.com")

      const res = await resetPassword(instance, await issuedResetToken(instance, guest.id))

      expect(res.status).toBe(200)
      expect(await credentialAccounts(instance, guest.id)).toHaveLength(1)
    })
  })
}
