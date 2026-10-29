import { createAccessControl } from "better-auth/plugins/access"
import { adminAc, defaultStatements, userAc } from "better-auth/plugins/admin/access"
import { describe, expect, it } from "vite-plus/test"
import { WAITLIST_ERROR_CODES, type WaitlistOptions } from "../index"
import { createWaitlistInstance, entryIdOf, setRole, signInAs } from "./harness"
import { createLogger } from "./logger"

const MANAGER_REQUESTS: Record<string, { method: "GET" | "POST"; query?: string; body?: unknown }> = {
  "/waitlist/admin/list": { method: "GET", query: "?status=pending&limit=10" },
  "/waitlist/admin/stats": { method: "GET" },
  "/waitlist/admin/approve": { method: "POST", body: { next: 1 } },
  "/waitlist/admin/reject": { method: "POST", body: { entryIds: ["missing"] } },
  "/waitlist/admin/requeue": { method: "POST", body: { entryId: "missing" } },
  "/waitlist/admin/resend-invite": { method: "POST", body: { entryId: "missing" } },
  "/waitlist/admin/invite": { method: "POST", body: { email: "invitee@example.com" } },
  "/waitlist/admin/boost": { method: "POST", body: { entryId: "missing", seconds: 60 } },
  "/waitlist/admin/delete": { method: "POST", body: { entryId: "missing" } },
}

type Instance = Awaited<ReturnType<typeof createWaitlistInstance>>

async function callManager(instance: Pick<Instance, "customFetchImpl">, path: string, headers = new Headers()) {
  const request = MANAGER_REQUESTS[path]
  if (!request) throw new Error(`No sample request for ${path}`)
  if (request.body !== undefined) headers.set("content-type", "application/json")
  const res = await instance.customFetchImpl(`http://localhost:3000/api/auth${path}${request.query ?? ""}`, {
    method: request.method,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  })
  const body: unknown = await res.json().catch(() => null)
  return { status: res.status, body }
}

const managerPaths = Object.keys(MANAGER_REQUESTS)

async function listStatus(instance: Pick<Instance, "customFetchImpl">, headers: Headers) {
  return (await callManager(instance, "/waitlist/admin/list", headers)).status
}

describe("manager access", () => {
  it("covers every manager endpoint", async () => {
    const { auth } = await createWaitlistInstance({})
    const paths = Object.values(auth.api)
      .flatMap((endpoint): unknown[] => ["path" in endpoint ? endpoint.path : undefined])
      .filter((path): path is string => typeof path === "string" && path.startsWith("/waitlist/admin/"))

    expect([...paths].sort()).toEqual([...managerPaths].sort())
  })

  it.each(managerPaths)("%s: 401 without a session", async (path) => {
    const instance = await createWaitlistInstance({})

    const res = await callManager(instance, path)

    expect(res.status).toBe(401)
  })

  it.each(managerPaths)("%s: 403 NOT_ALLOWED_TO_MANAGE_WAITLIST for a signed-in non-manager", async (path) => {
    const instance = await createWaitlistInstance({})
    const { headers } = await signInAs(instance, "user@example.com", "user")

    const res = await callManager(instance, path, headers)

    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ code: WAITLIST_ERROR_CODES.NOT_ALLOWED_TO_MANAGE_WAITLIST.code })
  })

  it.each(managerPaths)("%s: allowed for a manager", async (path) => {
    const instance = await createWaitlistInstance({})
    const { headers } = await signInAs(instance, "manager@example.com", "admin")

    const res = await callManager(instance, path, headers)

    expect([200, 404]).toContain(res.status)
  })

  it("leaves a user without a role out (the admin plugin's defaultRole applies)", async () => {
    const instance = await createWaitlistInstance({})
    const { headers } = await signInAs(instance, "nobody@example.com", null)

    expect(await listStatus(instance, headers)).toBe(403)
  })

  it("loses access as soon as the manager is demoted, despite the cookie cache", async () => {
    const instance = await createWaitlistInstance(
      {},
      { auth: { session: { cookieCache: { enabled: true, maxAge: 300 } } } }
    )
    const { user, headers } = await signInAs(instance, "manager@example.com", "admin")
    expect(await listStatus(instance, headers)).toBe(200)

    await setRole(instance.db, user.id, "user")

    const cached = await instance.auth.api.getSession({ headers })
    expect(cached?.user).toMatchObject({ role: "admin" })
    expect(await listStatus(instance, headers)).toBe(403)
  })

  it("loses access as soon as the manager is demoted, despite a secondary-storage session snapshot", async () => {
    const store = new Map<string, string>()
    const secondaryStorage = {
      get: (key: string) => store.get(key) ?? null,
      getAndDelete: (key: string) => {
        const value = store.get(key) ?? null
        store.delete(key)
        return value
      },
      increment: (key: string) => {
        const next = Number(store.get(key) ?? 0) + 1
        store.set(key, String(next))
        return next
      },
      set: (key: string, value: string) => void store.set(key, value),
      delete: (key: string) => void store.delete(key),
    }
    const instance = await createWaitlistInstance({}, { auth: { secondaryStorage } })
    const { user, headers } = await signInAs(instance, "manager@example.com", "admin")
    expect(await listStatus(instance, headers)).toBe(200)

    await setRole(instance.db, user.id, "user")
    expect((await instance.auth.api.getSession({ headers }))?.user).toMatchObject({ role: "admin" })

    expect(await listStatus(instance, headers)).toBe(403)
  })

  it("parses roles exactly as the admin plugin does: comma-separated, untrimmed", async () => {
    const instance = await createWaitlistInstance({})
    const spaced = await signInAs(instance, "spaced@example.com", "user, admin")
    const listed = await signInAs(instance, "listed@example.com", "user,admin")

    expect(await listStatus(instance, spaced.headers)).toBe(403)
    expect(await listStatus(instance, listed.headers)).toBe(200)
  })

  it("lets a manager drive the queue through the client", async () => {
    const instance = await createWaitlistInstance({})
    const { client } = instance
    const { headers } = await signInAs(instance, "manager@example.com", "admin")
    await client.waitlist.join({ email: "ada@example.com" })
    const entryId = await entryIdOf(instance, "ada@example.com")

    const boosted = await client.waitlist.admin.boost({ entryId, seconds: 5 }, { headers })
    const approved = await client.waitlist.admin.approve({ entryIds: [entryId] }, { headers })
    const stats = await client.waitlist.admin.stats({ fetchOptions: { headers } })
    const deleted = await client.waitlist.admin.delete({ entryId }, { headers })
    const unauthenticated = await client.waitlist.admin.stats()

    expect(approved.data?.results).toEqual([{ entryId, outcome: "approved" }])
    expect(stats.data).toMatchObject({ approved: 1, total: 1 })
    expect(boosted.data?.entry.boostSeconds).toBe(5)
    expect(deleted.data).toEqual({ success: true })
    expect(unauthenticated.error?.status).toBe(401)
  })

  it("allows a trusted server call with no headers and no request", async () => {
    const { auth } = await createWaitlistInstance({})
    await auth.api.joinWaitlist({ body: { email: "ada@example.com" } })

    const { entries, total } = await auth.api.listWaitlistEntries({ query: {} })

    expect(total).toBe(1)
    expect(entries[0]?.email).toBe("ada@example.com")
  })

  it("requires a manager session for a server call that carries headers", async () => {
    const { auth } = await createWaitlistInstance({})

    await expect(auth.api.listWaitlistEntries({ query: {}, headers: new Headers() })).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  it("records the manager as decidedById, and no one for a trusted server call", async () => {
    const instance = await createWaitlistInstance({})
    const { auth } = instance
    const { user, headers } = await signInAs(instance, "manager@example.com", "admin")
    await auth.api.joinWaitlist({ body: { email: "a@example.com" } })
    await auth.api.joinWaitlist({ body: { email: "b@example.com" } })

    await auth.api.approveWaitlistEntries({ body: { entryIds: [await entryIdOf(instance, "a@example.com")] }, headers })
    await auth.api.approveWaitlistEntries({ body: { entryIds: [await entryIdOf(instance, "b@example.com")] } })

    const { entries } = await auth.api.listWaitlistEntries({ query: { sortBy: "email" } })
    expect(entries.map((entry) => [entry.email, entry.decidedById ?? null])).toEqual([
      ["a@example.com", user.id],
      ["b@example.com", null],
    ])
  })
})

describe("default manager check (admin plugin)", () => {
  it("uses the admin plugin's adminRoles", async () => {
    const ac = createAccessControl(defaultStatements)
    const instance = await createWaitlistInstance(
      {},
      { admin: { ac, roles: { admin: adminAc, user: userAc, support: ac.newRole({}) }, adminRoles: ["support"] } }
    )
    const support = await signInAs(instance, "support@example.com", "support")
    const admin = await signInAs(instance, "admin@example.com", "admin")
    const both = await signInAs(instance, "both@example.com", "user,support")

    expect(await listStatus(instance, support.headers)).toBe(200)
    expect(await listStatus(instance, both.headers)).toBe(200)
    expect(await listStatus(instance, admin.headers)).toBe(403)
  })

  it("admits the admin plugin's adminUserIds whatever their role", async () => {
    const adminUserIds: string[] = []
    const instance = await createWaitlistInstance({}, { admin: { adminUserIds } })
    const listed = await signInAs(instance, "listed@example.com", "user")
    const other = await signInAs(instance, "other@example.com", "user")
    adminUserIds.push(listed.user.id)

    expect(await listStatus(instance, listed.headers)).toBe(200)
    expect(await listStatus(instance, other.headers)).toBe(403)
  })
})

describe("option: admin.permission", () => {
  it("requires the statement from the admin plugin's roles instead of adminRoles", async () => {
    const ac = createAccessControl({ ...defaultStatements, waitlist: ["manage", "view"] })
    const roles = {
      admin: ac.newRole({ ...adminAc.statements }),
      user: ac.newRole({ ...userAc.statements }),
      ops: ac.newRole({ waitlist: ["manage"] }),
      viewer: ac.newRole({ waitlist: ["view"] }),
    }
    const instance = await createWaitlistInstance(
      { admin: { permission: { waitlist: ["manage"] } } },
      { admin: { ac, roles } }
    )
    const ops = await signInAs(instance, "ops@example.com", "ops")
    const viewer = await signInAs(instance, "viewer@example.com", "viewer")
    const admin = await signInAs(instance, "admin@example.com", "admin")

    expect(await listStatus(instance, ops.headers)).toBe(200)
    expect(await listStatus(instance, viewer.headers)).toBe(403)
    expect(await listStatus(instance, admin.headers)).toBe(403)
  })
})

describe("option: admin.canManage", () => {
  const options = {
    admin: { canManage: ({ user }) => user.email.endsWith("@ops.test") },
  } satisfies WaitlistOptions

  it("replaces the default check", async () => {
    const instance = await createWaitlistInstance(options)
    const ops = await signInAs(instance, "someone@ops.test", "user")
    const admin = await signInAs(instance, "admin@example.com", "admin")

    expect(await listStatus(instance, ops.headers)).toBe(200)
    expect(await listStatus(instance, admin.headers)).toBe(403)
  })

  it("works without the admin plugin, and receives the user, session and context", async () => {
    const seen: { email: string; sessionUserId: string; path: string | undefined }[] = []
    const instance = await createWaitlistInstance(
      {
        admin: {
          canManage: ({ user, session, ctx }) => {
            seen.push({ email: user.email, sessionUserId: session.userId, path: ctx.path })
            return true
          },
        },
      },
      { admin: false }
    )
    const { user, headers } = await signInAs(instance, "someone@example.com", null)

    expect(await listStatus(instance, headers)).toBe(200)
    expect(seen).toEqual([{ email: "someone@example.com", sessionUserId: user.id, path: "/waitlist/admin/list" }])
  })
})

describe("no manager check available", () => {
  it("warns at startup and lets no session through, while trusted server calls still work", async () => {
    const { lines, logger } = createLogger()
    const instance = await createWaitlistInstance({}, { admin: false, auth: { logger } })
    await instance.auth.$context
    const { headers } = await signInAs(instance, "admin@example.com", null)

    expect(lines.some((line) => line.level === "warn" && line.message.includes("No manager check"))).toBe(true)
    expect(await listStatus(instance, headers)).toBe(403)
    expect((await instance.auth.api.getWaitlistStats({})).total).toBe(0)
  })

  it("does not warn when the admin plugin or canManage is there", async () => {
    const withAdmin = createLogger()
    const withCanManage = createLogger()
    await (
      await createWaitlistInstance({}, { auth: { logger: withAdmin.logger } })
    ).auth.$context
    await (
      await createWaitlistInstance(
        { admin: { canManage: () => true } },
        { admin: false, auth: { logger: withCanManage.logger } }
      )
    ).auth.$context

    for (const { lines } of [withAdmin, withCanManage]) {
      expect(lines.filter((line) => line.message.includes("No manager check"))).toEqual([])
    }
  })
})
