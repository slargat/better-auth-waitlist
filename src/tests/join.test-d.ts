import type { GenericEndpointContext } from "@better-auth/core"
import { betterAuth } from "better-auth"
import { describe, expectTypeOf, it } from "vite-plus/test"
import { type OnReferralSuccessData, type WaitlistEntry, type WaitlistOptions, waitlist } from "../index"

describe("joinWaitlist (types)", () => {
  it("accepts additionalFields, minus input: false ones", () => {
    const auth = betterAuth({
      plugins: [
        waitlist({
          schema: {
            waitlistEntry: {
              additionalFields: {
                company: { type: "string", required: false },
                source: { type: "string", required: false, input: false },
              },
            },
          },
        }),
      ],
    })
    type JoinBody = NonNullable<Parameters<typeof auth.api.joinWaitlist>[0]>["body"]

    expectTypeOf<JoinBody>().toHaveProperty("company")
    expectTypeOf<JoinBody>().not.toHaveProperty("source")
    expectTypeOf<JoinBody["email"]>().toEqualTypeOf<string>()
  })

  it("takes an optional referral code", () => {
    const auth = betterAuth({ plugins: [waitlist()] })
    type JoinBody = NonNullable<Parameters<typeof auth.api.joinWaitlist>[0]>["body"]

    expectTypeOf<JoinBody["referralCode"]>().toEqualTypeOf<string | undefined>()
  })
})

describe("onReferralSuccess (types)", () => {
  it("gets the referrer, the referred entry and the derived count", () => {
    type Callback = NonNullable<WaitlistOptions["onReferralSuccess"]>
    type Data = Parameters<Callback>[0]

    expectTypeOf<Data>().toEqualTypeOf<OnReferralSuccessData>()
    expectTypeOf<Data["referrer"]>().toEqualTypeOf<WaitlistEntry>()
    expectTypeOf<Data["referred"]>().toEqualTypeOf<WaitlistEntry>()
    expectTypeOf<Data["referralCount"]>().toEqualTypeOf<number>()
    expectTypeOf<Parameters<Callback>[1]>().toEqualTypeOf<GenericEndpointContext | null>()
    expectTypeOf<WaitlistEntry["referralSucceeded"]>().toEqualTypeOf<boolean>()
  })
})
