import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vite-plus/test"
import { WAITLIST_OPTION_PATHS } from "../options"

const testsDir = new URL(".", import.meta.url)

const describedOptions = () => {
  const tagged = new Set<string>()
  for (const file of readdirSync(testsDir)) {
    if (!file.endsWith(".test.ts")) continue
    const source = readFileSync(new URL(file, testsDir), "utf8")
    for (const match of source.matchAll(/describe\("option: ([\w.]+)"/g)) {
      if (match[1]) tagged.add(match[1])
    }
  }
  return tagged
}

describe("options coverage gate", () => {
  it('every option has a describe("option: <path>") block', () => {
    const tagged = describedOptions()

    expect(WAITLIST_OPTION_PATHS.filter((path) => !tagged.has(path))).toEqual([])
  })

  it("every option tag names a real option", () => {
    const known = new Set(WAITLIST_OPTION_PATHS)

    expect([...describedOptions()].filter((path) => !known.has(path))).toEqual([])
  })
})
