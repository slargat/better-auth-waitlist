import { readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import ts from "typescript"

/**
 * What a host's browser bundle pays for the client plugin, `defineErrorCodes`
 * included: about 2.0 kB today (unminified, comments included). Raise it
 * deliberately, in the PR that needs to, and say why.
 */
export const CLIENT_BUDGET_GZIP = 2560

/** Package imports the client may make: `defineErrorCodes` only (src/error-codes.ts). */
export const ALLOWED = new Set(["@better-auth/core/utils/error-codes"])

const STATIC_BUILTINS = new Set(["Object.hasOwn", "Object.groupBy", "Map.groupBy", "Promise.withResolvers"])
const METHOD_BUILTINS = new Set(["at", "findLast", "findLastIndex", "toSorted", "toReversed", "toSpliced"])

const defaultResolvePackage = (specifier) => fileURLToPath(import.meta.resolve(specifier))

/** The imports, uncheckable imports and modern built-ins of one module's source. */
export function scanModule(source, fileName = "module.mjs") {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const specifiers = []
  const problems = []
  const literal = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && literal(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (literal(argument)) specifiers.push(argument.text)
      else problems.push(`has a dynamic import() with a computed specifier: ${node.getText(file)}`)
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      problems.push(`calls require(): ${node.getText(file)}`)
    } else if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text
      if (ts.isIdentifier(node.expression) && STATIC_BUILTINS.has(`${node.expression.text}.${name}`)) {
        problems.push(`uses ${node.expression.text}.${name} (ES2022 or later)`)
      } else if (METHOD_BUILTINS.has(name) && ts.isCallExpression(node.parent) && node.parent.expression === node) {
        problems.push(`calls .${name}() (ES2022 or later)`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { specifiers, problems }
}

/** True when a module has no code: only comments and `export {}`. */
export function isTypesOnly(source) {
  const file = ts.createSourceFile("types.mjs", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  return file.statements.every(
    (statement) =>
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.length === 0
  )
}

/**
 * Check the built `./client` and `./types` under `root`. Returns the failures
 * (empty when it passes), the modules the client reaches and its gzipped size.
 */
export function checkClientGraph({
  root,
  client = "dist/client.mjs",
  types = "dist/types.mjs",
  budget = CLIENT_BUDGET_GZIP,
  resolvePackage = defaultResolvePackage,
}) {
  const failures = []
  const name = (file) => relative(root, file) || file
  const seen = new Set()
  const visit = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    const { specifiers, problems } = scanModule(readFileSync(file, "utf8"), file)
    for (const problem of problems) failures.push(`${name(file)} ${problem}`)
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier))
      else if (ALLOWED.has(specifier)) visit(resolvePackage(specifier))
      else failures.push(`${name(file)} imports ${specifier}`)
    }
  }
  visit(resolve(root, client))
  const modules = [...seen]
  const gzipped = gzipSync(modules.map((file) => readFileSync(file, "utf8")).join("\n")).length
  if (gzipped > budget) failures.push(`the client is ${gzipped} B gzipped, over its ${budget} B budget`)
  if (!isTypesOnly(readFileSync(resolve(root, types), "utf8")))
    failures.push(`${types} must be types only, but has code`)
  return { failures, modules, gzipped }
}
