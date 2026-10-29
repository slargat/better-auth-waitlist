import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it, onTestFinished } from "vite-plus/test"
import { checkClientGraph } from "../../scripts/client-graph.mjs"

const CLEAN_TYPES = "//#region src/types.ts\n//#endregion\nexport {};\n"

function check(files: Record<string, string>, options: { budget?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "client-graph-"))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, source] of Object.entries({ "dist/types.mjs": CLEAN_TYPES, ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), source)
  }
  return checkClientGraph({ root, ...options }).failures
}

describe("client graph check", () => {
  it("passes a client that imports only defineErrorCodes, through a chunk", () => {
    expect(
      check({
        "dist/client.mjs": 'import { t } from "./chunk.mjs";\nexport const client = () => t;\n',
        "dist/chunk.mjs":
          'import { defineErrorCodes } from "@better-auth/core/utils/error-codes";\nexport const t = defineErrorCodes({ A: "a" });\n',
      })
    ).toEqual([])
  })

  it.each([
    ["a static import", 'import * as z from "zod/mini";'],
    ["a minified static import", 'import{z}from"zod";'],
    ["a re-export", 'export * from "better-call";'],
    ["a named re-export", 'export { createAuthEndpoint } from "better-auth/api";'],
    ["a side-effect import", 'import "better-auth";'],
    ["a dynamic import with spacing", 'const z = await import ("zod");'],
    ["a dynamic import with a template literal", "const z = await import(`zod`);"],
  ])("fails on %s of a package outside the allowlist", (_, source) => {
    expect(check({ "dist/client.mjs": source })).toEqual([expect.stringMatching(/dist\/client\.mjs imports /)])
  })

  it("fails on a server module reached through a relative import", () => {
    expect(
      check({
        "dist/client.mjs": 'import "./index.mjs";',
        "dist/index.mjs": 'import { createAuthEndpoint } from "better-auth/api";',
      })
    ).toEqual(["dist/index.mjs imports better-auth/api"])
  })

  it.each([
    ["a variable", "const name = 'zod'; await import(name);"],
    // oxlint-disable-next-line no-template-curly-in-string -- fixture source; the substitution is what's tested
    ["a template with a substitution", "const x = 'mini'; await import(`zod/${x}`);"],
    ["a concatenation", "await import('zo' + 'd');"],
  ])("fails on a dynamic import of %s, which can't be checked", (_, source) => {
    expect(check({ "dist/client.mjs": source })).toEqual([
      expect.stringContaining("has a dynamic import() with a computed specifier"),
    ])
  })

  it.each([
    ["require of zod", 'const z = require("zod");'],
    ["require of anything", 'const x = require("./chunk.cjs");'],
  ])("fails on %s", (_, source) => {
    expect(check({ "dist/client.mjs": source })).toEqual([expect.stringContaining("calls require()")])
  })

  it.each([
    ["Object.hasOwn", "export const has = (o, k) => Object.hasOwn(o, k);"],
    [".at()", "export const last = (list) => list.at(-1);"],
    [".findLast()", "export const find = (list) => list.findLast(Boolean);"],
  ])("fails on the ES2022-or-later built-in %s", (_, source) => {
    expect(check({ "dist/client.mjs": source })).toEqual([expect.stringContaining("ES2022 or later")])
  })

  it("doesn't mistake a property named like a built-in for a call", () => {
    expect(check({ "dist/client.mjs": "export const at = { at: 1 }.at;" })).toEqual([])
  })

  it("fails when the types entry has code", () => {
    expect(check({ "dist/client.mjs": "export {};", "dist/types.mjs": "export const x = 1;" })).toEqual([
      "dist/types.mjs must be types only, but has code",
    ])
  })

  it("fails over the gzip budget", () => {
    expect(check({ "dist/client.mjs": "export const a = 1;" }, { budget: 10 })).toEqual([
      expect.stringMatching(/^the client is \d+ B gzipped, over its 10 B budget$/),
    ])
  })
})
