import ts from "typescript"
import { describe, expect, it } from "vite-plus/test"
import type { WaitlistOptions } from "../index"
import type { WaitlistOptionPath } from "../options"
import { createBackgroundTasks } from "./blocked-sign-up-cases"
import { cookiesFrom, createWaitlistInstance, PASSWORD, request, seedUser, signInAs } from "./harness"
import { createLogger } from "./logger"
import { createReferralInstance } from "./referral-cases"
import { pluginSources } from "./source-files"

type Fn = (...args: never[]) => unknown
type OptionAt<P extends string> = P extends `${infer G}.${infer K}`
  ? G extends keyof WaitlistOptions
    ? K extends keyof NonNullable<WaitlistOptions[G]>
      ? NonNullable<WaitlistOptions[G]>[K]
      : never
    : never
  : P extends keyof WaitlistOptions
    ? WaitlistOptions[P]
    : never
type HostFunctionPath = {
  [P in WaitlistOptionPath]: [Extract<OptionAt<P>, Fn>] extends [never] ? never : P
}[WaitlistOptionPath]

const secrets = new Set<string>()
const record = (value: string) => {
  secrets.add(value)
  return value
}

const quote = (...args: unknown[]) =>
  JSON.stringify(args, (_, value) => (value instanceof Headers ? [...value] : value))
const fail =
  (name: string) =>
  (...args: unknown[]) => {
    throw new Error(`${name} failed with ${quote(...args)}`)
  }
const request_ = (ctx: { headers?: Headers; body?: unknown } | null | undefined) => [ctx?.headers, ctx?.body]

const HOST_FUNCTIONS: Record<HostFunctionPath, { throwing: WaitlistOptions; fallback: WaitlistOptions }> = {
  "gate.bypass": {
    throwing: { gate: { bypass: ({ user, ctx }) => fail("bypass")(user, ...request_(ctx)) } },
    fallback: { gate: { bypass: () => false } },
  },
  "join.validate": {
    throwing: { join: { validate: (input) => fail("validate")(input, input.request?.headers) } },
    fallback: { join: { validate: () => false } },
  },
  "join.autoApprove": {
    throwing: { join: { autoApprove: (input) => fail("autoApprove")(input, input.request?.headers) } },
    fallback: { join: { autoApprove: () => false } },
  },
  "statusLink.buildUrl": {
    throwing: { statusLink: { buildUrl: (token) => fail("statusLink.buildUrl")(record(token)) } },
    fallback: {},
  },
  "invite.buildUrl": {
    throwing: { invite: { buildUrl: (code) => fail("invite.buildUrl")(record(code)) } },
    fallback: {},
  },
  "admin.canManage": {
    throwing: { admin: { canManage: ({ user, ctx }) => fail("canManage")(user, ...request_(ctx)) } },
    fallback: { admin: { canManage: () => false } },
  },
  sendStatusLink: {
    throwing: { sendStatusLink: async (data) => fail("sendStatusLink")(record(data.token), data) },
    fallback: {},
  },
  sendInvite: { throwing: { sendInvite: async (data) => fail("sendInvite")(record(data.code), data) }, fallback: {} },
  onJoin: { throwing: { onJoin: (data, ctx) => fail("onJoin")(data, ...request_(ctx)) }, fallback: {} },
  onStatusChange: {
    throwing: { onStatusChange: (data, ctx) => fail("onStatusChange")(data, ...request_(ctx)) },
    fallback: {},
  },
  onExistingUserJoin: {
    throwing: { onExistingUserJoin: async (data, req) => fail("onExistingUserJoin")(data, req?.headers) },
    fallback: {},
  },
  "referral.canonicalizeEmail": {
    throwing: { referral: { canonicalizeEmail: (email) => fail("canonicalizeEmail")(email) } },
    fallback: { referral: { canonicalizeEmail: () => "everyone@example.com" } },
  },
  onReferralSuccess: {
    throwing: { onReferralSuccess: (data, ctx) => fail("onReferralSuccess")(data, ...request_(ctx)) },
    fallback: {},
  },
}

const BASE = {
  invite: { returnCodeToManager: true, buildUrl: (code: string) => `https://app.test/r?i=${record(code)}` },
  statusLink: { buildUrl: (token: string) => `https://app.test/s?t=${record(token)}` },
  gate: { joinOnBlockedSignUp: true },
  sendStatusLink: async ({ token }: { token: string }) => void record(token),
  sendInvite: async ({ code }: { code: string }) => void record(code),
} satisfies WaitlistOptions

async function runFlow(options: WaitlistOptions) {
  secrets.clear()
  const { lines, logger } = createLogger()
  const background = createBackgroundTasks()
  const instance = await createWaitlistInstance(
    {
      ...BASE,
      ...options,
      invite: { ...BASE.invite, ...options.invite },
      statusLink: { ...BASE.statusLink, ...options.statusLink },
      gate: { ...BASE.gate, ...options.gate },
    },
    { auth: { logger, advanced: background.advanced } }
  )
  await seedUser(instance, "existing@example.com", { password: "correct-horse-battery" })
  const shape = async (res: Response) => {
    const body = (await res.json().catch(() => null)) as {
      code?: string
      valid?: boolean
      referralCount?: number
    } | null
    return [res.status, body?.code ?? body?.valid ?? null, body?.referralCount ?? null]
  }
  const steps: unknown[] = []
  const step = async (res: Promise<Response>) => void steps.push(await shape(await res))

  await step(request(instance, "/waitlist/join", { body: { email: "ada@example.com" } }))
  await step(request(instance, "/waitlist/join", { body: { email: "ada@example.com" } }))
  await step(request(instance, "/waitlist/join", { body: { email: "existing@example.com" } }))
  await background.settle()
  const [token = "no-token"] = secrets
  const statusOf = (statusToken: string) =>
    request(instance, `/waitlist/status?token=${encodeURIComponent(statusToken)}`)
  const status = await statusOf(token)
  await step(Promise.resolve(status.clone()))
  await step(request(instance, "/waitlist/confirm", { body: { token } }))
  const { referralCode } = (await status.json().catch(() => ({}))) as { referralCode?: string }
  const known = new Set(secrets)
  await step(request(instance, "/waitlist/join", { body: { email: "eve@example.com", referralCode } }))
  await background.settle()
  const [eveToken = "no-token"] = [...secrets].filter((secret) => !known.has(secret))
  await step(request(instance, "/waitlist/confirm", { body: { token: eveToken } }))
  await background.settle()
  await step(statusOf(token))
  const invited = await instance.auth.api.inviteToWaitlist({ body: { email: "bob@example.com" } })
  const code = record("code" in invited && typeof invited.code === "string" ? invited.code : "")
  const accepted = await request(instance, "/waitlist/invite/accept", { body: { code } })
  await step(Promise.resolve(accepted.clone()))
  const signUp = (email: string, cookie?: string) =>
    request(instance, "/sign-up/email", { body: { email, password: PASSWORD, name: email }, cookie })
  await step(signUp("bob@example.com", cookiesFrom(accepted)))
  await step(signUp("carol@example.com", cookiesFrom(accepted)))
  await step(signUp("dan@example.com"))
  const manager = await signInAs(instance, "manager@example.com", "user")
  await step(request(instance, "/waitlist/admin/stats", { cookie: manager.headers.get("cookie") ?? "" }))
  await background.settle()

  return {
    steps,
    secrets: [...secrets],
    errors: lines.filter((line) => line.level === "error").map((line) => line.message),
  }
}

describe("host functions that throw", () => {
  it.each(Object.entries(HOST_FUNCTIONS))(
    "%s: same responses as its fallback, logged, no code or token in the log",
    async (name, { throwing, fallback }) => {
      const failed = await runFlow(throwing)
      const answered = await runFlow(fallback)

      expect(failed.steps).toEqual(answered.steps)
      const label = name.split(".").at(-1) ?? name
      expect(failed.errors.some((line) => line.startsWith("[waitlist]") && line.includes(label))).toBe(true)
      expect(failed.secrets.length).toBeGreaterThan(0)
      for (const secret of failed.secrets) {
        for (const line of failed.errors) expect(line).not.toContain(secret)
      }
    }
  )
})

describe("host callback calls", () => {
  it("go through notifyHost (host.ts), which adds the request's secrets, never runCallback directly", () => {
    const direct = pluginSources().flatMap(({ path, source }) => {
      if (path === "callbacks.ts" || path === "host.ts") return []
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
      const found: string[] = []
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && node.text === "runCallback") {
          found.push(`${path}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
      return found
    })

    expect(direct).toEqual([])
  })
})

const HOST_FUNCTION_NAMES = new Set(Object.keys(HOST_FUNCTIONS).map((path) => path.split(".").at(-1) ?? path))

const OPTIONS_NAMES = ["opts", "options"]
const OPTIONS_TYPES = new Set(["ResolvedWaitlistOptions", "WaitlistOptions"])
const INVOKERS = new Set(["call", "apply", "bind"])
const HOST_WRAPPERS = new Set(["askHost", "notifyHost"])
const WRAPPED_ARGUMENT = 1

function strip(node: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return strip(node.expression)
  }
  return node
}

function memberName(node: ts.Expression) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text
  }
  return undefined
}

function keyText(key: ts.Node | undefined) {
  if (key && (ts.isIdentifier(key) || ts.isStringLiteralLike(key))) return key.text
  return undefined
}

function insideHostWrapper(node: ts.Node) {
  for (let at: ts.Node | undefined = node; at; at = at.parent) {
    const parent: ts.Node | undefined = at.parent
    if (
      (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
      parent &&
      ts.isCallExpression(parent) &&
      parent.arguments[WRAPPED_ARGUMENT] === at &&
      ts.isIdentifier(parent.expression) &&
      HOST_WRAPPERS.has(parent.expression.text)
    ) {
      return true
    }
  }
  return false
}

function unwrappedHostCalls(path: string, source: string) {
  const fileName = `/src/${path}`
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const checker = ts
    .createProgram({
      rootNames: [fileName],
      options: { noLib: true, noResolve: true, types: [] },
      host: {
        getSourceFile: (name) => (name === fileName ? file : undefined),
        writeFile: () => {},
        getDefaultLibFileName: () => "/lib.d.ts",
        useCaseSensitiveFileNames: () => true,
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => "/",
        getNewLine: () => "\n",
        fileExists: (name) => name === fileName,
        readFile: () => undefined,
      },
    })
    .getTypeChecker()
  const keyOf = (id: ts.Identifier): ts.Symbol | string => {
    const symbol =
      ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
        ? checker.getShorthandAssignmentValueSymbol(id.parent)
        : checker.getSymbolAtLocation(id)
    return symbol ?? `undeclared:${id.text}`
  }
  const optionKeys = new Set<ts.Symbol | string>(OPTIONS_NAMES.map((name) => `undeclared:${name}`))
  const hostKeys = new Set<ts.Symbol | string>()

  const kindOf = (expression: ts.Expression): "options" | "host" | null => {
    const node = strip(expression)
    if (ts.isIdentifier(node)) {
      const key = keyOf(node)
      if (optionKeys.has(key)) return "options"
      return hostKeys.has(key) ? "host" : null
    }
    const name = memberName(node)
    if (name === undefined || !(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return null
    if (name === "opts") return "options"
    const base = kindOf(node.expression)
    if (base === "options") return HOST_FUNCTION_NAMES.has(name) ? "host" : "options"
    return base === "host" && INVOKERS.has(name) ? "host" : null
  }
  const bind = (target: ts.Node, kind: "options" | "host"): boolean => {
    if (ts.isIdentifier(target)) {
      const keys = kind === "options" ? optionKeys : hostKeys
      const key = keyOf(target)
      const added = !keys.has(key)
      keys.add(key)
      return added
    }
    let added = false
    if (kind === "options" && ts.isObjectBindingPattern(target)) {
      for (const element of target.elements) {
        const key = keyText(element.propertyName ?? element.name)
        if (key !== undefined) added = bind(element.name, HOST_FUNCTION_NAMES.has(key) ? "host" : "options") || added
      }
    }
    if (kind === "options" && ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        const key = keyText(property.name)
        const into = ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isShorthandPropertyAssignment(property)
            ? property.name
            : undefined
        if (key !== undefined && into) added = bind(into, HOST_FUNCTION_NAMES.has(key) ? "host" : "options") || added
      }
    }
    return added
  }

  const collect = (node: ts.Node): boolean => {
    let added = false
    if (
      ts.isParameter(node) &&
      ts.isIdentifier(node.name) &&
      (OPTIONS_NAMES.includes(node.name.text) ||
        (node.type &&
          ts.isTypeReferenceNode(node.type) &&
          ts.isIdentifier(node.type.typeName) &&
          OPTIONS_TYPES.has(node.type.typeName.text)))
    ) {
      added = bind(node.name, "options")
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "resolveOptions"
    ) {
      added = bind(node.name, "options") || added
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const kind = kindOf(node.initializer)
      if (kind) added = bind(node.name, kind) || added
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const kind = kindOf(node.right)
      if (kind) added = bind(strip(node.left), kind) || added
    }
    let childAdded = false
    ts.forEachChild(node, (child) => {
      childAdded = collect(child) || childAdded
    })
    return added || childAdded
  }
  while (collect(file)) {}

  const isDeclarationName = (node: ts.Identifier) => {
    const parent = node.parent
    return (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) ||
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isParameter(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      isAssignmentTarget(node)
    )
  }
  const isAssignmentTarget = (node: ts.Node): boolean => {
    let at: ts.Node = node
    while (
      (ts.isPropertyAssignment(at.parent) && at.parent.initializer === at) ||
      (ts.isShorthandPropertyAssignment(at.parent) && at.parent.name === at) ||
      ts.isObjectLiteralExpression(at.parent) ||
      ts.isParenthesizedExpression(at.parent)
    ) {
      at = at.parent
    }
    return (
      ts.isBinaryExpression(at.parent) &&
      at.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      at.parent.left === at
    )
  }
  const useOf = (node: ts.Expression): "run" | "value" | "check" => {
    let outer: ts.Node = node
    while (
      ts.isParenthesizedExpression(outer.parent) ||
      ts.isNonNullExpression(outer.parent) ||
      ts.isAsExpression(outer.parent)
    ) {
      outer = outer.parent
    }
    const parent = outer.parent
    if (ts.isCallExpression(parent)) {
      if (parent.expression === outer) return "run"
      const callee = parent.expression
      return ts.isIdentifier(callee) && callee.text === "Boolean" ? "check" : "value"
    }
    if (ts.isPropertyAssignment(parent) && keyText(parent.name) === memberName(node)) return "check"
    if (
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isNewExpression(parent)
    ) {
      return "value"
    }
    return "check"
  }

  const found: string[] = []
  const visit = (node: ts.Node) => {
    const candidate =
      (ts.isIdentifier(node) && !isDeclarationName(node)) ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    if (candidate && kindOf(node) === "host") {
      const parent = node.parent
      const inner =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && kindOf(parent) === "host"
      if (!inner && useOf(node) !== "check" && !insideHostWrapper(node)) {
        found.push(`${path}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe("host function calls", () => {
  it("all run inside askHost or notifyHost, which redact the request's secrets from a throw", () => {
    expect(pluginSources().flatMap(({ path, source }) => unwrappedHostCalls(path, source))).toEqual([])
  })

  it.each([
    ["a direct call", "opts.gate.bypass({})"],
    ["a destructured name", "const { bypass } = opts.gate\nbypass({})"],
    ["a renamed destructured name", "const { buildUrl: build } = opts.statusLink\nbuild(token)"],
    ["a group alias by destructuring", "const { referral } = opts\nreferral.canonicalizeEmail(email)"],
    ["a group alias by assignment", "const gate = opts.gate\ngate.bypass({})"],
    ["an alias of an alias", "const o = opts\nconst g = o.gate\nconst f = g.bypass\nf({})"],
    ["nested destructuring", "const { gate: { bypass } } = opts\nbypass({})"],
    ["assignment destructuring", "let b\n;({ bypass: b } = opts.gate)\nb({})"],
    ["element access", "opts.gate['bypass']({})"],
    [".call", "opts.gate.bypass.call(null, {})"],
    [".apply", "opts.gate.bypass.apply(null, [{}])"],
    [".bind", "opts.gate.bypass.bind(null)({})"],
    ["an optional call", "opts.onReferralSuccess?.(data, ctx)"],
    ["a renamed options parameter", "function f(o: ResolvedWaitlistOptions) { o.gate.bypass({}) }"],
    ["the options parameter named options", "function f(options) { options.gate.bypass({}) }"],
    ["a member named opts", "scope.opts.join.validate(input)"],
    ["the function passed as a callback", "emails.map(opts.referral.canonicalizeEmail)"],
    ["the function put in an object", "run({ fn: opts.gate.bypass })"],
    ["the wrong argument of askHost", "askHost(scope, () => 1, (() => opts.gate.bypass({}))())"],
    ["a wrapper function that isn't the host call", "askHost(scope, () => 1, () => opts.gate.bypass({}))"],
  ])("catches %s", (_, source) => {
    expect(unwrappedHostCalls("probe.ts", source)).toHaveLength(1)
  })

  it.each([
    ["a call inside askHost", "const { bypass } = opts.gate\naskHost(scope, () => bypass({}), false)"],
    ["a call inside notifyHost", "notifyHost(scope, () => opts.onJoin(data, ctx))"],
    ["a presence check", "const { sendStatusLink: send } = opts\nif (!send) return\nopts.sendInvite && x"],
    ["Boolean()", "Boolean(opts.admin.canManage)"],
    ["a default", "const bypass = options.gate?.bypass ?? defaultBypass"],
    ["a non-host option", "opts.join.enabled\nopts.invite.header"],
  ])("allows %s", (_, source) => {
    expect(unwrappedHostCalls("probe.ts", source)).toEqual([])
  })
})

describe("callbacks on the gate path", () => {
  const SECRET_PASSWORD = 'pa"ss\\word-1234'

  it.each(["onStatusChange", "onReferralSuccess"] as const)(
    "%s that logs the sign-up body shows no password",
    async (name) => {
      const { lines, logger } = createLogger()
      const logBody = (_: unknown, ctx: { body?: unknown } | null) => {
        throw new Error(`${name} failed for ${JSON.stringify(ctx?.body)}`)
      }
      const instance = await createReferralInstance(
        name === "onStatusChange" ? { onStatusChange: logBody } : { onReferralSuccess: logBody },
        { auth: { logger } }
      )
      await instance.join("ada@example.com")
      await instance.join("bob@example.com", await instance.codeOf("ada@example.com"))
      const invited = await instance.api.inviteToWaitlist({ body: { email: "bob@example.com" } })
      const code = "code" in invited && typeof invited.code === "string" ? invited.code : ""

      const res = await request(instance, "/sign-up/email", {
        body: { email: "bob@example.com", password: SECRET_PASSWORD, name: "Bob" },
        headers: { "x-waitlist-invite": code },
      })

      expect(res.status).toBe(200)
      const errors = lines.filter((line) => line.level === "error").map((line) => line.message)
      expect(errors.some((line) => line.includes(`${name} callback failed`))).toBe(true)
      for (const line of errors) {
        expect(line).not.toContain(SECRET_PASSWORD)
        expect(line).not.toContain(JSON.stringify(SECRET_PASSWORD).slice(1, -1))
        expect(line).not.toContain(code)
      }
    }
  )
})
