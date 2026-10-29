import pg from "pg"
import { describe, expect, it } from "vite-plus/test"
import { defineBlockedSignUpCases, defineSingleUseCases } from "./blocked-sign-up-cases"
import { useFakeGoogle } from "./google"
import { admit, createWaitlistInstance, PASSWORD, request, usersWith } from "./harness"

useFakeGoogle()

defineBlockedSignUpCases("postgres")
defineSingleUseCases("postgres")

describe("invite claim without the user table's unique email (postgres)", () => {
  it("admits one of eight concurrent sign-ups with one code: the claim, not the index, decides", async () => {
    const instance = await createWaitlistInstance({ invite: { returnCodeToManager: true } }, { testWith: "postgres" })
    if (!(instance.database instanceof pg.Pool)) throw new Error("expected the harness's pg Pool")
    const { rows } = await instance.database.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"user"'::regclass AND contype = 'u'`
    )
    for (const { conname } of rows) await instance.database.query(`ALTER TABLE "user" DROP CONSTRAINT "${conname}"`)
    const code = await admit(instance, "ada@example.com")

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(instance, "/sign-up/email", {
          body: { email: "ada@example.com", password: PASSWORD, name: "Ada" },
          headers: { "x-waitlist-invite": code },
        })
      )
    )

    expect(responses.filter((res) => res.status === 200)).toHaveLength(1)
    expect(await usersWith(instance.db, "ada@example.com")).toHaveLength(1)
  })
})
