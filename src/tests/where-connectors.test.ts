import { describe, expect, it } from "vite-plus/test"
import { pluginSources } from "./source-files"

describe("adapter where clauses", () => {
  it("never set a connector in plugin source", () => {
    const offenders = pluginSources().filter(({ source }) => /\bconnector\s*:/.test(source))

    expect(offenders.map(({ path }) => path)).toEqual([])
  })
})
