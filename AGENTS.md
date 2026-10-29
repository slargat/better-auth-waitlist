# better-auth-waitlist

A Better Auth plugin that gates sign-up behind a waitlist. Published to npm as `better-auth-waitlist`.

Read before changing code:

- [`CONTEXT.md`](./CONTEXT.md): the glossary. Use its terms in code, tests, issues and PRs.
- [`CODING_STANDARDS.md`](./CODING_STANDARDS.md): the enforceable rules (gating, data model, endpoints, tests, package hygiene).
- [`README.md`](./README.md) and [`docs/`](./docs): the documented behaviour and options. [`CONTRIBUTING.md`](./CONTRIBUTING.md): development and release workflow.

## Commands

```sh
pnpm install
pnpm lint                 # vp lint (Oxlint, type-aware) + vp fmt --check (Oxfmt); `pnpm fmt` to format
pnpm typecheck            # tsc --noEmit
pnpm test                 # unit + *.test-d.ts type tests (Vitest project "unit")
pnpm test:postgres:local  # Postgres suites in a throwaway Docker container (Vitest project "postgres")
pnpm build                # vp pack (tsdown: writes package.json exports, runs publint and attw) + client-graph and declaration checks
```

Lint, format, pack and test config all live in `vite.config.ts`. Import test APIs from `vite-plus/test`.

## Workflow

- Branch from `main` and open PRs against `main`.
- Every user-visible change needs a changeset (`pnpm changeset`). Releases go out through `.github/workflows/release.yml`; never publish by hand.
- While Changesets is in pre mode (`.changeset/pre.json`), `changeset publish` uses the pre tag (`beta`) as the npm dist-tag, so prereleases never reach `latest`. Release 4.0.0 with `changeset pre exit`.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` before pushing.
