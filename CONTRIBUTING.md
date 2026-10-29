# Contributing

Read [`CONTEXT.md`](./CONTEXT.md) (the vocabulary) and [`CODING_STANDARDS.md`](./CODING_STANDARDS.md) (the rules every change keeps) first. The [README](./README.md) is the documented behaviour: update it in the same PR as a behaviour change.

## Development

```sh
pnpm install
pnpm build                # vp pack (tsdown, ESM only; writes package.json exports, runs publint --strict and attw) + client-graph and declaration checks
pnpm typecheck            # tsc --noEmit
pnpm test                 # vp test (unit + *.test-d.ts type tests)
pnpm test:postgres:local  # the Postgres suites against a throwaway postgres:16 container (needs Docker)
pnpm lint                 # vp lint (Oxlint) + vp fmt --check (Oxfmt)
```

Lint, format, build and test settings all live in [`vite.config.ts`](./vite.config.ts). The Postgres suites are the `postgres` test project; `pnpm test:postgres` runs them against `WAITLIST_TEST_DATABASE_URL`.

The client-graph check (`scripts/check-client-graph.mjs`, run by `build`) parses every module `dist/client.mjs` reaches and fails if any imports zod, `better-call`, server code or any package but `@better-auth/core/utils/error-codes`, has an `import()` with a computed specifier, calls `require()`, or uses an ES2022-or-later built-in; also if `dist/types.mjs` has code, or if the client is over its **2.5 kB gzip budget**. `src/tests/client-graph.test.ts` runs it on fixtures. Raise the budget only on purpose, in the PR that needs it.

`build` also type-checks the emitted declarations as a consumer would (`scripts/check-dts.mjs`, `skipLibCheck: false`), so a declaration-bundler slip fails here and not in a host's `tsc`.

The client's `version` comes from a build-time define (`__WAITLIST_VERSION__`, set from `package.json` for both the build and the tests); code compiled without it reports `"dev"`.

CI also runs typecheck and both test suites with `better-auth` and `@better-auth/core` swapped for the 1.7.0 floor and the latest 1.7.x.

To try a local change in an app before it is released, link the checkout from the app (`pnpm link ../better-auth-waitlist`, or a `link:` override) and run `pnpm build` here: the `exports` map resolves to `dist/`.

## Releasing

Releases go through [Changesets](https://github.com/changesets/changesets) and `.github/workflows/release.yml` (npm trusted publishing, with provenance; no npm token). Add a changeset to every PR with a user-visible change:

```sh
pnpm changeset
```

Merging to `main` opens or updates the "Version Packages" PR; merging that PR publishes to npm, tags the release and creates the GitHub Release.
