import { describe, expect, it } from "vite-plus/test"
import { defineGuestClaimCases } from "./guest-claim-cases"
import { admit, createWaitlistInstance, databaseWithoutTransactions, entryOf, PASSWORD, seedUser } from "./harness"

defineGuestClaimCases("sqlite")

function accountLinkFailingOnce() {
  let failed = false
  return {
    account: {
      create: {
        before: async () => {
          if (failed) return
          failed = true
          throw new Error("transient host failure")
        },
      },
    },
  }
}

describe("sign-up: a Guest's claim without a real transaction", () => {
  it("keeps the invite when the account link fails, so the claim can be retried with the same code", async () => {
    const instance = await createWaitlistInstance(
      { invite: { returnCodeToManager: true } },
      { auth: { database: databaseWithoutTransactions(), databaseHooks: accountLinkFailingOnce() } }
    )
    const guest = await seedUser(instance, "guest@example.com")
    const code = await admit(instance, "guest@example.com")
    const signUp = () =>
      instance.client.signUp.email(
        { email: "guest@example.com", password: PASSWORD, name: "Ada Guest" },
        { headers: { "x-waitlist-invite": code } }
      )

    const failed = await signUp()
    expect(failed.error).not.toBeNull()
    const retry = await signUp()

    expect(retry.error).toBeNull()
    expect(retry.data?.user.id).toBe(guest.id)
    expect(await entryOf(instance, "guest@example.com")).toMatchObject({ status: "registered", userId: guest.id })
  })
})
