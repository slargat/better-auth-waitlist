import ts from "typescript"
import { describe, expect, it } from "vite-plus/test"
import { pluginSources } from "./source-files"

const DATA_MODULES = ["entries.ts", "state-machine.ts"]

const ADAPTER_SOURCES = [
  "currentAdapter",
  "getCurrentAdapter",
  "runWithAdapter",
  "runWithTransaction",
  "getCurrentDBAdapterAsyncLocalStorage",
]

function unwrap(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) return unwrap(node.expression)
  return node
}

interface Use {
  path: string
  line: number
  kind: "adapter" | "source" | "aliased"
  method: string | null
  owner?: string | null
}

const ALLOWED_UNGUARDED = [{ path: "entries.ts", owner: "unlinkReferralsOf", method: "updateMany" }]

function ownerOf(node: ts.Node): string | null {
  let owner: string | null = null
  for (let at: ts.Node | undefined = node; at; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isVariableDeclaration(at)) && at.name && ts.isIdentifier(at.name)) {
      owner = at.name.text
    }
  }
  return owner
}

function aliasesIn(file: ts.SourceFile) {
  const sources = new Set(ADAPTER_SOURCES)
  const adapters = new Set<string>()
  const declarations: ts.VariableDeclaration[] = []
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.push(node)
    ts.forEachChild(node, collect)
  }
  collect(file)
  for (let changed = true; changed;) {
    changed = false
    for (const declaration of declarations) {
      const name = (declaration.name as ts.Identifier).text
      const init = unwrap(declaration.initializer as ts.Expression)
      const resolver =
        (ts.isIdentifier(init) && sources.has(init.text)) ||
        (ts.isArrowFunction(init) && !ts.isBlock(init.body) && isAdapter(init.body, sources, adapters))
      if (resolver && !sources.has(name)) {
        sources.add(name)
        changed = true
      } else if (isAdapter(init, sources, adapters) && !adapters.has(name)) {
        adapters.add(name)
        changed = true
      }
    }
  }
  return { sources, adapters }
}

function isAdapter(node: ts.Expression, sources: Set<string>, adapters: Set<string>) {
  const inner = unwrap(node)
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text === "adapter"
  if (ts.isIdentifier(inner)) return adapters.has(inner.text)
  return ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && sources.has(inner.expression.text)
}

function adapterUses(path: string, source: string): Use[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const { sources, adapters } = aliasesIn(file)
  const uses: Use[] = []
  const at = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart()).line + 1
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && isAdapter(node.expression, sources, adapters)) {
      uses.push({ path, line: at(node), kind: "adapter", method: node.name.text, owner: ownerOf(node) })
    } else if (ts.isPropertyAccessExpression(node) && node.name.text === "adapter") {
      const parent = node.parent
      if (!(ts.isPropertyAccessExpression(parent) && parent.expression === node)) {
        uses.push({ path, line: at(node), kind: "adapter", method: null })
      }
    }
    if (ts.isIdentifier(node) && sources.has(node.text)) {
      uses.push({ path, line: at(node), kind: "source", method: null })
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && sources.has(node.expression.text)) {
      let outer: ts.Node = node
      while (ts.isParenthesizedExpression(outer.parent) || ts.isAwaitExpression(outer.parent)) outer = outer.parent
      const usedAtOnce =
        (ts.isPropertyAccessExpression(outer.parent) && outer.parent.expression === outer) ||
        (ts.isArrowFunction(outer.parent) && outer.parent.body === outer)
      if (!usedAtOnce && !["runWithAdapter", "runWithTransaction"].includes(node.expression.text)) {
        uses.push({ path, line: at(node), kind: "aliased", method: null })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return uses
}

const allUses = () => pluginSources().flatMap(({ path, source }) => adapterUses(path, source))
const where = (uses: Use[]) => uses.map(({ path, line }) => `${path}:${line}`)

describe("database access", () => {
  it("happens only in entries.ts and state-machine.ts", () => {
    const outside = allUses().filter((use) => !DATA_MODULES.includes(use.path))

    expect(where(outside)).toEqual([])
  })

  it("never uses an unguarded update or updateMany, except the one allowed referral unlink", () => {
    const allowed = (use: Use) =>
      ALLOWED_UNGUARDED.some((rule) => rule.path === use.path && rule.owner === use.owner && rule.method === use.method)
    const unguarded = allUses().filter(
      (use) => (use.method === "update" || use.method === "updateMany") && !allowed(use)
    )

    expect(where(unguarded)).toEqual([])
    expect(allUses().filter(allowed)).toHaveLength(ALLOWED_UNGUARDED.length)
  })

  it("allows updateMany only inside the allow-listed function", () => {
    const uses = adapterUses(
      "entries.ts",
      [
        "const db = currentAdapter",
        "const unlinkReferralsOf = async (c) => (await db(c)).updateMany({})",
        "const other = async (c) => (await db(c)).updateMany({})",
      ].join("\n")
    )

    expect(uses.filter((use) => use.method === "updateMany").map((use) => use.owner)).toEqual([
      "unlinkReferralsOf",
      "other",
    ])
  })

  it("creates rows only in the state machine", () => {
    const creates = allUses().filter((use) => use.method === "create" && use.path !== "state-machine.ts")

    expect(where(creates)).toEqual([])
  })

  it("never keeps the current adapter in a variable, so every method called on it is visible", () => {
    expect(where(allUses().filter((use) => use.kind === "aliased"))).toEqual([])
  })

  it("sees adapter access in code, not in comments or strings", () => {
    const uses = adapterUses(
      "probe.ts",
      "// ctx.context.adapter.update()\nconst s = 'context.adapter.create'\nctx.context.adapter.update({})"
    )

    expect(uses).toEqual([{ path: "probe.ts", line: 3, kind: "adapter", method: "update", owner: null }])
  })

  it("sees writes through an alias of the resolver, and through an adapter kept in a variable", () => {
    const uses = adapterUses(
      "entries.ts",
      [
        "const db = currentAdapter",
        "const other = (c) => db(c)",
        "export const f = async (c) => (await db(c)).update({})",
        "export const g = async (c) => (await other(c)).updateMany({})",
        "export const h = async (c) => { const a = c.adapter; return a.update({}) }",
      ].join("\n")
    )

    expect(uses.filter((use) => use.method === "update" || use.method === "updateMany").map((use) => use.line)).toEqual(
      [3, 4, 5]
    )
  })

  it("sees writes through the current adapter, and an aliased one", () => {
    const uses = adapterUses(
      "probe.ts",
      "async () => {\nawait (await currentAdapter(ctx)).update({})\nconst a = await currentAdapter(ctx)\na.updateMany({})\n}"
    )

    expect(uses.map(({ line, kind, method }) => [line, kind, method])).toEqual([
      [2, "adapter", "update"],
      [2, "source", null],
      [3, "aliased", null],
      [3, "source", null],
      [4, "adapter", "updateMany"],
    ])
  })
})
