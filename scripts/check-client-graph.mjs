import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { CLIENT_BUDGET_GZIP, checkClientGraph } from "./client-graph.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const { failures, modules, gzipped } = checkClientGraph({ root })

if (failures.length > 0) {
  console.error(`✗ client graph:\n  ${failures.join("\n  ")}`)
  process.exit(1)
}
console.log(
  `✔ dist/client.mjs: ${modules.length} module(s), only allowed imports, no ES2022 built-ins, ${gzipped} B gzipped (budget ${CLIENT_BUDGET_GZIP} B)`
)
console.log("✔ dist/types.mjs: types only")
