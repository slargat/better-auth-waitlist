import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import type { BetterAuthOptions, BetterAuthPlugin } from "@better-auth/core"
import { memoryAdapter } from "better-auth/adapters/memory"
import { parseSetCookieHeader, setCookieToHeader } from "better-auth/cookies"
import { getMigrations } from "better-auth/db/migration"
import { type AdminOptions, admin } from "better-auth/plugins/admin"
import { emailOTP } from "better-auth/plugins/email-otp"
import { magicLink } from "better-auth/plugins/magic-link"
import { getTestInstance } from "better-auth/test"
import pg from "pg"
import { onTestFinished } from "vite-plus/test"
import { waitlistClient } from "../client"
import { type SendInviteData, type SendStatusLinkData, type WaitlistOptions, waitlist } from "../index"

export async function createWaitlistInstance<O extends WaitlistOptions>(
  waitlistOptions: O,
  config: {
    auth?: Omit<Partial<BetterAuthOptions>, "plugins">
    rateLimit?: boolean
    testWith?: "sqlite" | "postgres"
    admin?: AdminOptions | false
    plugins?: BetterAuthPlugin[]
  } = {}
) {
  const outbox = createOutbox()
  const adminPlugins = config.admin === false ? [] : [admin(config.admin)]
  const database =
    config.testWith === "postgres" ? await postgresSchema() : (config.auth?.database ?? new DatabaseSync(":memory:"))
  const options = {
    ...config.auth,
    ...(config.rateLimit ? { rateLimit: { enabled: true, storage: "database" as const } } : {}),
    ...(database ? { database } : {}),
    ...(database instanceof pg.Pool
      ? {
          advanced: {
            ...config.auth?.advanced,
            database: { ...config.auth?.advanced?.database, validateSchema: false },
          },
        }
      : {}),
    plugins: [
      ...(config.plugins ?? []),
      waitlist(waitlistOptions),
      ...adminPlugins,
      magicLink({ sendMagicLink: async ({ email, url }) => void outbox.magicLinks.push({ email, url }) }),
      emailOTP({ sendVerificationOTP: async ({ email, otp }) => void outbox.otps.push({ email, otp }) }),
    ],
  }
  if (typeof database !== "function") {
    const migrate = async () => (await getMigrations(options)).runMigrations()
    await (database instanceof pg.Pool ? withSchemaLock(migrate) : migrate())
  }
  const instance = await getTestInstance(options, {
    disableTestUser: true,
    testWith: "sqlite",
    clientOptions: { plugins: [waitlistClient()] },
  })
  return { ...instance, outbox, database }
}

function createOutbox() {
  const magicLinks: { email: string; url: string }[] = []
  const otps: { email: string; otp: string }[] = []
  const last = <T extends { email: string }>(list: T[], email: string, what: string) => {
    const found = list.filter((item) => item.email === email).at(-1)
    if (!found) throw new Error(`No ${what} was sent to ${email}`)
    return found
  }
  return {
    magicLinks,
    otps,
    magicLinkFor: (email: string) => last(magicLinks, email, "magic link").url,
    otpFor: (email: string) => last(otps, email, "OTP").otp,
  }
}

async function postgresSchema() {
  const url = testDatabaseUrl()
  const schema = `wl_${randomUUID().replaceAll("-", "_")}`
  const admin = new pg.Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` })
  onTestFinished(async () => {
    await pool.end()
    await withSchemaLock(() => admin.query(`DROP SCHEMA "${schema}" CASCADE`))
    await admin.end()
  })
  return pool
}

function testDatabaseUrl() {
  const url = process.env.WAITLIST_TEST_DATABASE_URL
  if (!url) {
    throw new Error("Postgres suites need WAITLIST_TEST_DATABASE_URL (run `pnpm test:postgres:local`)")
  }
  return url
}

const SCHEMA_LOCK = 336_336

async function withSchemaLock<T>(fn: () => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() })
  await client.connect()
  try {
    await client.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK])
    return await fn()
  } finally {
    await client.end()
  }
}

type TestInstance = Awaited<ReturnType<typeof createWaitlistInstance>>
type TestDB = TestInstance["db"]
type Api = TestInstance["auth"]["api"]

interface ManagerInstance {
  auth: { api: Pick<Api, "listWaitlistEntries" | "approveWaitlistEntries" | "rejectWaitlistEntries"> }
}
interface InviteInstance {
  auth: { api: Pick<Api, "inviteToWaitlist"> }
}
interface SignUpInstance extends InviteInstance {
  client: { signUp: Pick<TestInstance["client"]["signUp"], "email"> }
}
interface UserInstance {
  auth: { $context: TestInstance["auth"]["$context"] }
  client: { signIn: Pick<TestInstance["client"]["signIn"], "email"> }
  db: TestDB
}

export async function entryIdOf(instance: ManagerInstance, email: string) {
  const { entries } = await instance.auth.api.listWaitlistEntries({ query: { search: email } })
  const entry = entries.find((candidate) => candidate.email === email)
  if (!entry) throw new Error(`No waitlist entry for ${email}`)
  return entry.id
}

export async function entryOf(instance: ManagerInstance, email: string) {
  const { entries } = await instance.auth.api.listWaitlistEntries({ query: { search: email } })
  return entries.find((candidate) => candidate.email === email)
}

export async function approveEntry(instance: ManagerInstance, email: string) {
  const entryId = await entryIdOf(instance, email)
  await instance.auth.api.approveWaitlistEntries({ body: { entryIds: [entryId] } })
  return entryId
}

export async function rejectEntry(instance: ManagerInstance, email: string) {
  const entryId = await entryIdOf(instance, email)
  await instance.auth.api.rejectWaitlistEntries({ body: { entryIds: [entryId] } })
  return entryId
}

export async function admit(instance: InviteInstance, email: string) {
  const res = await instance.auth.api.inviteToWaitlist({ body: { email } })
  if (!("code" in res) || typeof res.code !== "string") {
    throw new Error("admit() needs an instance with `invite: { returnCodeToManager: true }`")
  }
  return res.code
}

export const PASSWORD = "password1234"

export async function signUpAdmitted(instance: SignUpInstance, email: string) {
  const code = await admit(instance, email)
  const res = await instance.client.signUp.email(
    { email, password: PASSWORD, name: email },
    { headers: { "x-waitlist-invite": code } }
  )
  if (res.error) throw new Error(`signUpAdmitted(${email}) failed: ${res.error.status} ${res.error.code}`)
  return res.data.user
}

export async function signInAs(instance: UserInstance, email: string, role: string | null = "admin") {
  const user = await seedUser(instance, email, { password: PASSWORD })
  await setRole(instance.db, user.id, role)
  const headers = new Headers()
  await instance.client.signIn.email({ email, password: PASSWORD }, { onSuccess: setCookieToHeader(headers) })
  return { user, headers }
}

export async function setRole(db: TestDB, userId: string, role: string | null) {
  await db.update({ model: "user", where: [{ field: "id", value: userId }], update: { role } })
}

const ISSUERS = { credential: "local:credential", google: "https://accounts.google.com" } as const

export async function seedUser(
  instance: Pick<UserInstance, "auth" | "db">,
  email: string,
  { password, google }: { password?: string; google?: string } = {}
) {
  const { db } = instance
  const now = new Date()
  const user = await db.create<Record<string, unknown>, { id: string; email: string }>({
    model: "user",
    data: { email, name: email, emailVerified: true, createdAt: now, updatedAt: now },
  })
  if (password) {
    const context = await instance.auth.$context
    await seedAccount(instance, user.id, "credential", user.id, { password: await context.password.hash(password) })
  }
  if (google) await seedAccount(instance, user.id, "google", google)
  return user
}

export async function seedAccount(
  instance: Pick<UserInstance, "auth" | "db">,
  userId: string,
  providerId: keyof typeof ISSUERS,
  accountId: string,
  extra: Record<string, unknown> = {}
) {
  const context = await instance.auth.$context
  const now = new Date()
  const issuer = "issuer" in (context.tables.account?.fields ?? {}) ? { issuer: ISSUERS[providerId] } : {}
  await instance.db.create({
    model: "account",
    data: { userId, providerId, accountId, createdAt: now, updatedAt: now, ...issuer, ...extra },
  })
}

export async function failRegisterWrites(instance: { database: unknown }) {
  const { database } = instance
  if (database instanceof DatabaseSync) {
    database.exec(
      `CREATE TRIGGER fail_register BEFORE UPDATE ON waitlistEntry WHEN NEW.status = 'registered'
       BEGIN SELECT RAISE(ABORT, 'register write failed'); END`
    )
    return async () => {
      database.exec("DROP TRIGGER fail_register")
    }
  }
  if (database instanceof pg.Pool) {
    await database.query(`CREATE FUNCTION fail_register() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status = 'registered' THEN RAISE EXCEPTION 'register write failed'; END IF; RETURN NEW; END $$`)
    await database.query(
      `CREATE TRIGGER fail_register BEFORE UPDATE ON "waitlistEntry" FOR EACH ROW EXECUTE FUNCTION fail_register()`
    )
    return async () => void (await database.query(`DROP TRIGGER fail_register ON "waitlistEntry"`))
  }
  throw new Error("failRegisterWrites needs the harness's sqlite or Postgres database")
}

export function databaseWithoutTransactions(): NonNullable<BetterAuthOptions["database"]> {
  const factory = memoryAdapter({
    user: [],
    session: [],
    account: [],
    verification: [],
    waitlistEntry: [],
    rateLimit: [],
  })
  return (options: BetterAuthOptions) => {
    const adapter = factory(options)
    return {
      ...adapter,
      transaction: (work) => work(adapter),
      options: { ...adapter.options, adapterConfig: { ...adapter.options?.adapterConfig, transaction: false } },
    } as typeof adapter
  }
}

export async function usersWith(db: TestDB, email: string) {
  return db.findMany<{ id: string; email: string; emailVerified: boolean }>({
    model: "user",
    where: [{ field: "email", value: email }],
  })
}

export function createMailbox() {
  const sent: SendStatusLinkData[] = []
  const options = {
    statusLink: { buildUrl: (token: string) => `https://app.test/waitlist?token=${token}` },
    sendStatusLink: async (data: SendStatusLinkData) => {
      sent.push(data)
    },
  } satisfies WaitlistOptions

  return {
    sent,
    options,
    tokenFor(email: string) {
      const last = sent.filter((mail) => mail.email === email).at(-1)
      if (!last) throw new Error(`No status link was sent to ${email}`)
      return last.token
    },
  }
}

export function createInviteMailbox(extra: WaitlistOptions["invite"] = {}) {
  const sent: SendInviteData[] = []
  const options = {
    invite: { buildUrl: (code: string) => `https://app.test/register?invite=${code}`, ...extra },
    sendInvite: async (data: SendInviteData) => {
      sent.push(data)
    },
  } satisfies WaitlistOptions
  return {
    sent,
    options,
    codeFor(email: string) {
      const last = sent.filter((mail) => mail.email === email).at(-1)
      if (!last) throw new Error(`No invite was sent to ${email}`)
      return last.code
    },
  }
}

export function cookiesFrom(res: Response, cookie = "") {
  const jar = new Map(
    cookie
      .split("; ")
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf("=")
        return [pair.slice(0, at), pair.slice(at + 1)] as const
      })
  )
  for (const [name, { value, "max-age": maxAge }] of parseSetCookieHeader(res.headers.get("set-cookie") ?? "")) {
    if (maxAge === 0 || value === "") jar.delete(name)
    else jar.set(name, value)
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ")
}

export function request(
  instance: { auth: { handler: (request: Request) => Promise<Response> } },
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}
) {
  const url = path.startsWith("http") ? path : `http://localhost:3000/api/auth${path}`
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set("cookie", init.cookie)
  if (init.body !== undefined) headers.set("content-type", "application/json")
  return instance.auth.handler(
    new Request(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    })
  )
}
