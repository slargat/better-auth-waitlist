import { describe, expect, it } from "vite-plus/test"
import type { WaitlistOptions } from "../index"
import {
  admit,
  createWaitlistInstance,
  entryIdOf,
  entryOf,
  failRegisterWrites,
  PASSWORD,
  request,
  usersWith,
} from "./harness"

const ADMITTING = { invite: { returnCodeToManager: true } } satisfies WaitlistOptions

function failingOnce() {
  let failed = false
  return {
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            if (failed) return
            failed = true
            throw new Error("transient host failure")
          },
        },
      },
    },
  }
}

type Instance = Awaited<ReturnType<typeof createWaitlistInstance>>

async function magicLink(instance: Instance, email: string, headers: Record<string, string> = {}) {
  await request(instance, "/sign-in/magic-link", {
    body: { email, callbackURL: "/dashboard", errorCallbackURL: "/register" },
  })
  return request(instance, instance.outbox.magicLinkFor(email), { headers })
}
const landedOn = (res: Response) => new URL(res.headers.get("location") ?? "", "http://x").pathname

export function defineRecoveryCases(testWith: "sqlite" | "postgres") {
  describe(`a failed creation keeps the invite (${testWith})`, () => {
    it("lets a magic-link sign-up be retried with the same code after its creation failed", async () => {
      const instance = await createWaitlistInstance(ADMITTING, { testWith, auth: failingOnce() })
      const code = await admit(instance, "ada@example.com")

      const failed = await magicLink(instance, "ada@example.com", { "x-waitlist-invite": code })
      expect(landedOn(failed)).not.toBe("/dashboard")
      expect(await usersWith(instance.db, "ada@example.com")).toEqual([])
      const retry = await magicLink(instance, "ada@example.com", { "x-waitlist-invite": code })

      expect(landedOn(retry)).toBe("/dashboard")
      expect(await usersWith(instance.db, "ada@example.com")).toHaveLength(1)
      expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
    })

    it("leaves no entry behind when an auto-approved magic-link creation fails, and admits the retry", async () => {
      const instance = await createWaitlistInstance(
        { ...ADMITTING, join: { autoApprove: ({ emailVerified }) => emailVerified } },
        { testWith, auth: failingOnce() }
      )

      const failed = await magicLink(instance, "bob@corp.test")
      expect(landedOn(failed)).not.toBe("/dashboard")
      expect(await entryOf(instance, "bob@corp.test")).toBeUndefined()
      const retry = await magicLink(instance, "bob@corp.test")

      expect(landedOn(retry)).toBe("/dashboard")
      expect(await entryOf(instance, "bob@corp.test")).toMatchObject({ status: "registered" })
    })

    it("recovers a claimed invite whose user is gone with a resend, and refuses the resend while the user exists", async () => {
      const instance = await createWaitlistInstance(ADMITTING, { testWith })
      const code = await admit(instance, "ada@example.com")
      const entryId = await entryIdOf(instance, "ada@example.com")
      const restore = await failRegisterWrites(instance)
      const signUp = (headers: Record<string, string>) =>
        request(instance, "/sign-up/email", {
          body: { email: "ada@example.com", password: PASSWORD, name: "Ada" },
          headers,
        })
      expect((await signUp({ "x-waitlist-invite": code })).status).toBe(200)
      await restore()
      await expect(instance.auth.api.resendWaitlistInvite({ body: { entryId } })).rejects.toMatchObject({
        statusCode: 409,
      })

      const [user] = await usersWith(instance.db, "ada@example.com")
      await instance.db.delete({ model: "user", where: [{ field: "id", value: user?.id ?? "" }] })
      const resent = await instance.auth.api.resendWaitlistInvite({ body: { entryId } })

      expect((await signUp({ "x-waitlist-invite": resent.code ?? "" })).status).toBe(200)
      expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
    })

    it("creates one user for one code under concurrent magic-link sign-ups outside a transaction", async () => {
      const instance = await createWaitlistInstance(ADMITTING, { testWith })
      const code = await admit(instance, "ada@example.com")
      const links: string[] = []
      for (let n = 0; n < 6; n++) {
        await request(instance, "/sign-in/magic-link", {
          body: { email: "ada@example.com", callbackURL: "/dashboard" },
        })
        links.push(instance.outbox.magicLinkFor("ada@example.com"))
      }

      const responses = await Promise.all(
        links.map((link) => request(instance, link, { headers: { "x-waitlist-invite": code } }))
      )

      expect(responses.filter((res) => landedOn(res) === "/dashboard").length).toBeGreaterThanOrEqual(1)
      expect(await usersWith(instance.db, "ada@example.com")).toHaveLength(1)
      expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
    })
  })
}
