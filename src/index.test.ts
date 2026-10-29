import { describe, expect, it } from "vite-plus/test"
import { createWaitlistInstance, PASSWORD, seedUser } from "./tests/harness"

describe("waitlist plugin (smoke)", () => {
  it("boots Better Auth with the plugin registered", async () => {
    const { auth } = await createWaitlistInstance({})
    const ctx = await auth.$context

    expect(ctx.hasPlugin("waitlist")).toBe(true)
  })

  it("does not block sign-in for an existing user", async () => {
    const instance = await createWaitlistInstance({})
    await seedUser(instance, "existing@example.com", { password: PASSWORD })

    const res = await instance.client.signIn.email({ email: "existing@example.com", password: PASSWORD })

    expect(res.error).toBeNull()
    expect(res.data?.user.email).toBe("existing@example.com")
  })
})
