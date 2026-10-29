import { readdirSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = resolve(root, "dist")
const entries = readdirSync(dist)
  .filter((file) => file.endsWith(".d.mts"))
  .map((file) => resolve(dist, file))
for (const entry of ["index.d.mts", "client.d.mts", "types.d.mts"]) {
  if (!entries.includes(resolve(dist, entry))) {
    console.error(`✗ dist/${entry} is missing: run tsdown first`)
    process.exit(1)
  }
}

const program = ts.createProgram(entries, {
  strict: true,
  noEmit: true,
  skipLibCheck: false,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  types: ["node"],
})
const ours = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.file?.fileName.startsWith(dist))

if (ours.length > 0) {
  const host = {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  }
  console.error(`✗ dist declarations have type errors:\n${ts.formatDiagnostics(ours, host)}`)
  process.exit(1)
}
console.log(`✔ dist declarations: ${entries.map((file) => relative(root, file)).join(", ")} type-check`)
