import type { BetterAuthPlugin } from "@better-auth/core"
import { getCurrentAdapter } from "@better-auth/core/context"
import { describe, expect, it } from "vite-plus/test"
import { createWaitlistInstance, PASSWORD, request } from "./harness"

describe("Better Auth 1.7 user creation transaction (pinned)", () => {
  it("runs user.create.before in a transaction, and a base-adapter query from it runs only after the commit", async () => {
    const events: string[] = []
    let scoped = false
    let base: Promise<number> = Promise.resolve(-1)
    const probe: BetterAuthPlugin = {
      id: "transaction-probe",
      init(ctx) {
        return {
          options: {
            databaseHooks: {
              user: {
                create: {
                  before: async () => {
                    scoped = (await getCurrentAdapter(ctx.adapter)) !== ctx.adapter
                    base = ctx.adapter.count({ model: "user" }).then((count) => {
                      events.push("base query answered")
                      return count
                    })
                    events.push("hook returned")
                  },
                },
              },
            },
          },
        }
      },
    }
    const instance = await createWaitlistInstance({ gate: { enabled: false } }, { plugins: [probe] })

    const res = await request(instance, "/sign-up/email", {
      body: { email: "ada@example.com", password: PASSWORD, name: "Ada" },
    })

    expect(res.status).toBe(200)
    expect(scoped).toBe(true)
    expect(await base).toBe(1)
    expect(events).toEqual(["hook returned", "base query answered"])
  })
})
