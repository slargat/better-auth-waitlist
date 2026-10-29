import { readdirSync, readFileSync } from "node:fs"

const srcDir = new URL("../", import.meta.url)

const walk = (dir: URL): URL[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === "tests" ? [] : walk(new URL(`${entry.name}/`, dir))
    return entry.name.endsWith(".ts") && !/\.test(-d)?\.ts$/.test(entry.name) ? [new URL(entry.name, dir)] : []
  })

export const pluginSources = () =>
  walk(srcDir).map((file) => ({
    path: file.pathname.slice(srcDir.pathname.length),
    source: readFileSync(file, "utf8"),
  }))
