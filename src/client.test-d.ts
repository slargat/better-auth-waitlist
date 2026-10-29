import type { RawError } from "@better-auth/core/utils/error-codes"
import { betterAuth } from "better-auth"
import { createAuthClient } from "better-auth/client"
import { describe, expectTypeOf, it } from "vite-plus/test"
import {
  type WaitlistEntry as ClientWaitlistEntry,
  type WaitlistStatus as ClientWaitlistStatus,
  getRedirectError,
  isWaitlistError,
  WAITLIST_ERROR_CODES,
  type WaitlistErrorCode,
  type WaitlistRedirectError,
  waitlistClient,
} from "./client"
import { type WaitlistEntry, type WaitlistStatus, waitlist } from "./index"
import type * as Types from "./types"

const client = createAuthClient({ baseURL: "http://localhost:3000", plugins: [waitlistClient()] })
const { waitlist: wl } = client

type Data<T> = NonNullable<Awaited<T> extends { data: infer D } ? D : never>
type Input<F extends (...args: never[]) => unknown> = Omit<NonNullable<Parameters<F>[0]>, "fetchOptions">

type Status = "pending" | "approved" | "rejected" | "registered"

describe("waitlistClient (types)", () => {
  it("infers the server plugin", () => {
    type Inferred = ReturnType<typeof waitlistClient>["$InferServerPlugin"]
    expectTypeOf<Inferred["id"]>().toEqualTypeOf<"waitlist">()
    expectTypeOf<keyof Inferred["endpoints"]>().toEqualTypeOf<keyof ReturnType<typeof waitlist>["endpoints"]>()
    expectTypeOf(waitlistClient().id).toEqualTypeOf<"waitlist">()
    expectTypeOf(waitlistClient().version).toEqualTypeOf<string>()
  })

  it("composes with createAuthClient", () => {
    expectTypeOf(client.signIn.email).toBeFunction()
  })
})

describe("public actions (types)", () => {
  it("join: the server's body and { success: true }", () => {
    type Body = Input<typeof wl.join>
    expectTypeOf<Body["email"]>().toEqualTypeOf<string>()
    expectTypeOf<Body["name"]>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Body["referralCode"]>().toEqualTypeOf<string | undefined>()
    const join = () => wl.join({ email: "ada@example.com" })
    expectTypeOf<Data<ReturnType<typeof join>>>().toEqualTypeOf<{ success: boolean }>()
  })

  it("join: additionalFields from the client options, minus input: false ones, as the server takes them", () => {
    const schema = {
      waitlistEntry: {
        additionalFields: {
          company: { type: "string", required: true },
          seats: { type: "number", required: false },
          source: { type: "string", required: false, input: false },
        },
      },
    } as const
    const typed = createAuthClient({ baseURL: "http://localhost:3000", plugins: [waitlistClient({ schema })] })
    const auth = betterAuth({ plugins: [waitlist({ schema })] })
    type Body = Input<typeof typed.waitlist.join>
    type ServerBody = NonNullable<Parameters<typeof auth.api.joinWaitlist>[0]>["body"]

    expectTypeOf<Body>().toExtend<ServerBody>()
    expectTypeOf<ServerBody>().toExtend<Body>()
    expectTypeOf<{ email: string; company: string }>().toExtend<Body>()
    expectTypeOf<{ email: string }>().not.toExtend<ServerBody>()
    expectTypeOf<{ email: string }>().not.toExtend<Body>()
    expectTypeOf<Body["company"]>().toEqualTypeOf<string>()
    expectTypeOf<Body["seats"]>().toEqualTypeOf<number | undefined>()
    expectTypeOf<Body>().not.toHaveProperty("source")
    expectTypeOf<Input<typeof wl.join>>().not.toHaveProperty("company")
  })

  it("status: GET with { query: { token } }, and the derived referralCount", () => {
    type Query = Input<typeof wl.status>["query"]
    expectTypeOf<Query>().toEqualTypeOf<{ token: string }>()
    const read = () => wl.status({ query: { token: "t" } })
    type Status = Data<ReturnType<typeof read>>
    expectTypeOf<Status["email"]>().toEqualTypeOf<string>()
    expectTypeOf<Status["status"]>().toEqualTypeOf<WaitlistStatus>()
    expectTypeOf<Status["position"]>().toEqualTypeOf<number | null>()
    expectTypeOf<Status["queueLength"]>().toEqualTypeOf<number>()
    expectTypeOf<Status["referralCode"]>().toEqualTypeOf<string>()
    expectTypeOf<Status["referralCount"]>().toEqualTypeOf<number>()
    expectTypeOf<Status["emailConfirmed"]>().toEqualTypeOf<boolean>()
    expectTypeOf<Status["invite"]>().toEqualTypeOf<{ expiresAt: Date | null; expired: boolean } | null>()
  })

  it("confirm: { token } and { success: true }", () => {
    expectTypeOf<Input<typeof wl.confirm>>().toEqualTypeOf<{ token: string }>()
    const confirm = () => wl.confirm({ token: "t" })
    expectTypeOf<Data<ReturnType<typeof confirm>>>().toEqualTypeOf<{ success: boolean }>()
  })

  it("invite.accept: { code } and the valid / invalid union", () => {
    expectTypeOf<Input<typeof wl.invite.accept>>().toEqualTypeOf<{ code: string }>()
    const accept = () => wl.invite.accept({ code: "c" })
    expectTypeOf<Data<ReturnType<typeof accept>>>().toEqualTypeOf<
      { valid: true; email: string; expiresAt: Date | null } | { valid: false }
    >()
  })
})

describe("manager actions (types)", () => {
  const { admin } = wl
  type Outcome<Done extends string> = Done | "skipped" | "invalid_transition" | "not_found" | "error"

  it("admin.list: the server's query and { entries, total }", () => {
    type Query = NonNullable<Input<typeof admin.list>["query"]>
    expectTypeOf<Query["status"]>().toEqualTypeOf<Status | undefined>()
    expectTypeOf<Query["search"]>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Query["sortBy"]>().toEqualTypeOf<"queue" | "createdAt" | "email" | undefined>()
    expectTypeOf<Query["sortDirection"]>().toEqualTypeOf<"asc" | "desc" | undefined>()
    expectTypeOf<Query["referredById"]>().toEqualTypeOf<string | undefined>()
    const list = () => admin.list({ query: { status: "pending" } })
    type List = Data<ReturnType<typeof list>>
    expectTypeOf<List["total"]>().toEqualTypeOf<number>()
    expectTypeOf<List["entries"][number]["email"]>().toEqualTypeOf<string>()
    expectTypeOf<List["entries"][number]["status"]>().toEqualTypeOf<WaitlistStatus>()
    expectTypeOf<Extract<List["entries"][number], { position: number }>["position"]>().toEqualTypeOf<number>()
    expectTypeOf<List["entries"][number]>().toExtend<WaitlistEntry>()
  })

  it("admin.stats: no input, every count", () => {
    const stats = () => admin.stats()
    expectTypeOf<Data<ReturnType<typeof stats>>>().toEqualTypeOf<{
      pending: number
      pendingConfirmed: number
      approved: number
      approvedExpired: number
      rejected: number
      registered: number
      successfulReferrals: number
      total: number
    }>()
  })

  it("admin.approve: entryIds or next, and per-entry outcomes with an optional code", () => {
    const byIds = () => admin.approve({ entryIds: ["e"] })
    const next = () => admin.approve({ next: 10, confirmedOnly: false })
    type Result = Data<ReturnType<typeof byIds>>["results"][number]
    expectTypeOf<Result["entryId"]>().toEqualTypeOf<string>()
    expectTypeOf<Result["outcome"]>().toEqualTypeOf<Outcome<"approved">>()
    expectTypeOf<Result["code"]>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Data<ReturnType<typeof next>>>().toEqualTypeOf<Data<ReturnType<typeof byIds>>>()
    // @ts-expect-error entryIds or next is required
    void admin.approve({})
  })

  it("admin.reject: entryIds and an optional reason", () => {
    type Body = Input<typeof admin.reject>
    expectTypeOf<Body["entryIds"]>().toEqualTypeOf<string[]>()
    expectTypeOf<Body["reason"]>().toEqualTypeOf<string | undefined>()
    const reject = () => admin.reject({ entryIds: ["e"] })
    type Result = Data<ReturnType<typeof reject>>["results"][number]
    expectTypeOf<Result["outcome"]>().toEqualTypeOf<Outcome<"rejected">>()
  })

  it("admin.requeue / admin.boost: { entry }", () => {
    expectTypeOf<Input<typeof admin.requeue>>().toEqualTypeOf<{ entryId: string }>()
    expectTypeOf<Input<typeof admin.boost>>().toEqualTypeOf<{ entryId: string; seconds: number }>()
    const requeue = () => admin.requeue({ entryId: "e" })
    const boost = () => admin.boost({ entryId: "e", seconds: 60 })
    expectTypeOf<Data<ReturnType<typeof requeue>>["entry"]["status"]>().toEqualTypeOf<WaitlistStatus>()
    expectTypeOf<Data<ReturnType<typeof boost>>["entry"]["boostSeconds"]>().toEqualTypeOf<number>()
  })

  it("admin.resendInvite / admin.invite: { entry, code? }", () => {
    expectTypeOf<Input<typeof admin.resendInvite>>().toEqualTypeOf<{ entryId: string }>()
    type InviteBody = Input<typeof admin.invite>
    expectTypeOf<InviteBody["email"]>().toEqualTypeOf<string>()
    expectTypeOf<InviteBody["name"]>().toEqualTypeOf<string | undefined>()
    const resend = () => admin.resendInvite({ entryId: "e" })
    const invite = () => admin.invite({ email: "ada@example.com" })
    for (const data of [{} as Data<ReturnType<typeof resend>>, {} as Data<ReturnType<typeof invite>>]) {
      expectTypeOf(data.entry.email).toEqualTypeOf<string>()
      expectTypeOf(data).toHaveProperty("code")
    }
  })

  it("admin.delete: { entryId } and { success }", () => {
    expectTypeOf<Input<typeof admin.delete>>().toEqualTypeOf<{ entryId: string }>()
    const remove = () => admin.delete({ entryId: "e" })
    expectTypeOf<Data<ReturnType<typeof remove>>>().toEqualTypeOf<{ success: boolean }>()
  })
})

describe("error codes and helpers (types)", () => {
  it("$ERROR_CODES carries every waitlist code next to Better Auth's own", () => {
    expectTypeOf(client.$ERROR_CODES.WAITLIST_INVITE_REQUIRED).toEqualTypeOf<RawError<"WAITLIST_INVITE_REQUIRED">>()
    expectTypeOf(client.$ERROR_CODES.NOT_ALLOWED_TO_MANAGE_WAITLIST).toEqualTypeOf<
      RawError<"NOT_ALLOWED_TO_MANAGE_WAITLIST">
    >()
    expectTypeOf(client.$ERROR_CODES).toHaveProperty("USER_NOT_FOUND")
    expectTypeOf(waitlistClient().$ERROR_CODES).toEqualTypeOf(WAITLIST_ERROR_CODES)
    expectTypeOf<keyof typeof WAITLIST_ERROR_CODES>().toEqualTypeOf<WaitlistErrorCode>()
  })

  it("getRedirectError returns one of the two gate codes or null", () => {
    expectTypeOf(getRedirectError).parameter(0).toEqualTypeOf<string | URLSearchParams>()
    expectTypeOf(getRedirectError).returns.toEqualTypeOf<WaitlistRedirectError | null>()
    expectTypeOf<WaitlistRedirectError>().toEqualTypeOf<"WAITLIST_INVITE_REQUIRED" | "INVALID_INVITE_CODE">()
    expectTypeOf(wl.getRedirectError).toEqualTypeOf(getRedirectError)
  })

  it("isWaitlistError narrows a { code } error and keeps the rest of it", () => {
    const join = () => wl.join({ email: "ada@example.com" })
    type JoinError = NonNullable<Awaited<ReturnType<typeof join>>["error"]>
    const error = {} as JoinError | null
    if (isWaitlistError(error)) {
      expectTypeOf(error.code).toEqualTypeOf<WaitlistErrorCode>()
      expectTypeOf(error.status).toEqualTypeOf<number>()
    }
    const unknownError: unknown = null
    if (isWaitlistError(unknownError)) expectTypeOf(unknownError.code).toEqualTypeOf<WaitlistErrorCode>()
    expectTypeOf(wl.isWaitlistError).toEqualTypeOf(isWaitlistError)
  })
})

describe("re-exports (types)", () => {
  it("./client re-exports WaitlistEntry and WaitlistStatus", () => {
    expectTypeOf<ClientWaitlistEntry>().toEqualTypeOf<WaitlistEntry>()
    expectTypeOf<ClientWaitlistStatus>().toEqualTypeOf<WaitlistStatus>()
    expectTypeOf<ClientWaitlistStatus>().toEqualTypeOf<Status>()
  })

  it("./types carries the public types, and the onReferralSuccess payload", () => {
    expectTypeOf<Types.WaitlistEntry>().toEqualTypeOf<WaitlistEntry>()
    expectTypeOf<Types.WaitlistStatus>().toEqualTypeOf<WaitlistStatus>()
    expectTypeOf<Types.WaitlistErrorCode>().toEqualTypeOf<WaitlistErrorCode>()
    expectTypeOf<Types.OnReferralSuccessData>().toEqualTypeOf<{
      referrer: WaitlistEntry
      referred: WaitlistEntry
      referralCount: number
    }>()
  })
})

describe("getPlugin('waitlist') (types)", () => {
  it("is typed through the registry with the options it was given", async () => {
    const options = { join: { maxEntries: 500 }, referral: { successOn: "register" } } as const
    const auth = betterAuth({ plugins: [waitlist(options)] })
    const plugin = (await auth.$context).getPlugin("waitlist")

    expectTypeOf(plugin).not.toBeNull()
    expectTypeOf<NonNullable<typeof plugin>["id"]>().toEqualTypeOf<"waitlist">()
    expectTypeOf<NonNullable<typeof plugin>["options"]>().toEqualTypeOf<typeof options>()
    expectTypeOf<NonNullable<typeof plugin>["endpoints"]>().toHaveProperty("joinWaitlist")
  })
})
