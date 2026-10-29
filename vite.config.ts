import { defineConfig } from "vite-plus"
import { versionDefine } from "./scripts/version-define.mjs"

const betterCall = "Not a dependency. Import endpoint helpers from better-auth/api and types from better-auth."
const zodMini = 'Plugin code uses zod/mini only: import * as z from "zod/mini".'

export default defineConfig({
  define: versionDefine(),
  pack: {
    entry: ["./src/index.ts", "./src/client.ts", "./src/types.ts"],
    format: ["esm"],
    platform: "neutral",
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    fixedExtension: true,
    define: versionDefine(),
    exports: { legacy: true },
    publint: {
      strict: true,
    },
    attw: {
      profile: "esm-only",
      level: "error",
    },
  },
  lint: {
    plugins: ["typescript", "import"],
    categories: { correctness: "error" },
    options: { typeAware: true, typeCheck: true },
    env: { builtin: true, es2024: true },
    ignorePatterns: ["dist/**", "coverage/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "better-call", message: betterCall },
            { name: "zod", message: zodMini },
            { name: "zod/v4", message: zodMini },
            { name: "zod/v3", message: zodMini },
            { name: "zod/v4/core", message: zodMini },
          ],
        },
      ],
      "no-var": "error",
      "prefer-const": "error",
      "no-useless-catch": "error",
      "no-template-curly-in-string": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/await-thenable": "error",
      "import/no-duplicates": "error",
    },
    overrides: [
      {
        files: ["src/**/*.test.ts", "src/**/*.test-d.ts", "src/**/*.spec.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [
                { name: "better-call", message: betterCall },
                {
                  name: "better-auth/test",
                  message:
                    "Use createWaitlistInstance from ./harness: it always passes disableTestUser, which the gate needs.",
                },
              ],
            },
          ],
        },
      },
    ],
  },
  fmt: {
    semi: false,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "es5",
    printWidth: 120,
    endOfLine: "lf",
    sortPackageJson: false,
    ignorePatterns: ["dist/", "node_modules/", "coverage/", "pnpm-lock.yaml", "CHANGELOG.md"],
  },
  test: {
    environment: "node",
    watch: false,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
          exclude: ["src/**/*.postgres.test.ts"],
          typecheck: {
            enabled: true,
            include: ["src/**/*.test-d.ts"],
          },
        },
      },
      {
        extends: true,
        test: {
          name: "postgres",
          include: ["src/**/*.postgres.test.ts"],
        },
      },
    ],
  },
})
