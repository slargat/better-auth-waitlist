import { describe } from "vite-plus/test"
import { defineMalformedCodeCases, defineReferralConcurrencyCases, defineReferrerErasureCases } from "./referral-cases"

describe("referral success claim (postgres)", () => {
  defineReferralConcurrencyCases("postgres")
})

describe("referrer erasure (postgres)", () => {
  defineReferrerErasureCases("postgres")
})

describe("malformed referral codes (postgres)", () => {
  defineMalformedCodeCases("postgres")
})
