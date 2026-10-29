import { readFileSync } from "node:fs"

/**
 * The `define` that gives the client plugin its `version` (src/version.ts):
 * package.json's version as a literal. Shared by tsdown and both vitest
 * configs, so the build and the tests agree. Plain JS, so every config loader
 * (tsdown's native one included) can import it.
 *
 * @returns {{ __WAITLIST_VERSION__: string }}
 */
export function versionDefine() {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  return { __WAITLIST_VERSION__: JSON.stringify(version) }
}
