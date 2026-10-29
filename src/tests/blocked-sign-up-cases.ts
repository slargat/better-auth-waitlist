import type { BetterAuthPlugin } from "@better-auth/core"
import { getCurrentAdapter } from "@better-auth/core/context"
import { describe, expect, it } from "vite-plus/test"
import type { OnJoinData, WaitlistOptions } from "../index"
import { signInWithGoogle } from "./google"
import {
  admit,
  createMailbox,
  createWaitlistInstance,
  entryIdOf,
  entryOf,
  PASSWORD,
  request,
  usersWith,
} from "./harness"

export const rollbackProbe: BetterAuthPlugin = {
  id: "rollback-probe",
  init(ctx) {
    return {
      options: {
        databaseHooks: {
          user: {
            create: {
              before: async (user) => {
                const now = new Date()
                const adapter = await getCurrentAdapter(ctx.adapter)
                await adapter.create({
                  model: "verification",
                  data: {
                    identifier: `probe:${user.email}`,
                    value: "written inside the creation's transaction",
                    expiresAt: new Date(now.getTime() + 60_000),
                    createdAt: now,
                    updatedAt: now,
                  },
                })
              },
            },
          },
        },
      },
    }
  },
}

export function createBackgroundTasks() {
  const tasks: Promise<unknown>[] = []
  return {
    advanced: { backgroundTasks: { handler: (task: Promise<unknown>) => void tasks.push(task) } },
    settle: async () => {
      for (let settled = 0; settled < tasks.length; settled = tasks.length) await Promise.all(tasks)
    },
  }
}

export async function createBlockedSignUpInstance(
  testWith: "sqlite" | "postgres",
  options: WaitlistOptions = {},
  auth: { emailAndPassword?: { enabled: true; requireEmailVerification?: boolean } } = {}
) {
  const mailbox = createMailbox()
  const background = createBackgroundTasks()
  const joins: OnJoinData[] = []
  const instance = await createWaitlistInstance(
    {
      ...mailbox.options,
      gate: { joinOnBlockedSignUp: true },
      onJoin: (data) => void joins.push(data),
      ...options,
    },
    { testWith, plugins: [rollbackProbe], auth: { advanced: background.advanced, ...auth } }
  )
  const probeRows = (email: string) =>
    instance.db.findMany({ model: "verification", where: [{ field: "identifier", value: `probe:${email}` }] })
  return { ...instance, mailbox, joins, settle: background.settle, probeRows }
}

export function defineBlockedSignUpCases(testWith: "sqlite" | "postgres") {
  describe(`joinOnBlockedSignUp across the creation's rollback (${testWith})`, () => {
    it("an email sign-up's entry survives the rollback, and the status link is sent", async () => {
      const instance = await createBlockedSignUpInstance(testWith)

      const res = await request(instance, "/sign-up/email", {
        body: { email: "ada@example.com", password: PASSWORD, name: "Ada" },
      })
      await instance.settle()

      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ code: "WAITLIST_INVITE_REQUIRED" })
      expect(await instance.probeRows("ada@example.com")).toEqual([])
      expect(await usersWith(instance.db, "ada@example.com")).toEqual([])
      expect(await entryOf(instance, "ada@example.com")).toMatchObject({
        status: "pending",
        name: "Ada",
        emailConfirmed: false,
      })
      expect(instance.mailbox.sent.map((mail) => [mail.email, mail.reason])).toEqual([
        ["ada@example.com", "blocked-sign-up"],
      ])
      expect(instance.joins.map((join) => [join.entry.email, join.source])).toEqual([["ada@example.com", "sign-up"]])
    })

    it("an OAuth sign-up's entry survives the rollback, confirmed when the provider verified the email", async () => {
      const instance = await createBlockedSignUpInstance(testWith)

      const res = await signInWithGoogle(instance, { email: "ada@example.com", emailVerified: true })
      await instance.settle()

      expect(new URL(res.headers.get("location") ?? "", "http://x").searchParams.get("error")).toBe(
        "WAITLIST_INVITE_REQUIRED"
      )
      expect(await instance.probeRows("ada@example.com")).toEqual([])
      expect(await entryOf(instance, "ada@example.com")).toMatchObject({
        status: "pending",
        emailConfirmed: true,
        confirmedAt: expect.any(Date),
      })
    })
  })
}

export function defineSingleUseCases(testWith: "sqlite" | "postgres") {
  describe(`invite codes under concurrent sign-ups (${testWith})`, () => {
    it("creates one user and registers once when five sign-ups race with the same code", async () => {
      const changes: string[] = []
      const instance = await createWaitlistInstance(
        { invite: { returnCodeToManager: true }, onStatusChange: (data) => void changes.push(data.event) },
        { testWith }
      )
      const code = await admit(instance, "ada@example.com")
      changes.length = 0

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(instance, "/sign-up/email", {
            body: { email: "ada@example.com", password: PASSWORD, name: "Ada" },
            headers: { "x-waitlist-invite": code },
          })
        )
      )

      expect(responses.filter((res) => res.status === 200)).toHaveLength(1)
      expect(await usersWith(instance.db, "ada@example.com")).toHaveLength(1)
      expect(changes).toEqual(["register"])
      expect(await entryOf(instance, "ada@example.com")).toMatchObject({ status: "registered" })
    })

    it("lets exactly one of a resend and a sign-up with the old code win, every time", async () => {
      const instance = await createWaitlistInstance({ invite: { returnCodeToManager: true } }, { testWith })
      for (let round = 0; round < 10; round++) {
        const email = `ada${round}@example.com`
        const old = await admit(instance, email)
        const entryId = await entryIdOf(instance, email)

        const [signUp, resent] = await Promise.all([
          request(instance, "/sign-up/email", {
            body: { email, password: PASSWORD, name: "Ada" },
            headers: { "x-waitlist-invite": old },
          }),
          instance.auth.api.resendWaitlistInvite({ body: { entryId } }).then(
            () => true,
            () => false
          ),
        ])

        expect({ round, status: signUp.status, resent }).toEqual({ round, status: resent ? 403 : 200, resent })
        expect(await usersWith(instance.db, email)).toHaveLength(resent ? 0 : 1)
      }
    })
  })
}
