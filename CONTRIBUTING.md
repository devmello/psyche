# Contributing to Psyche

Psyche is built by many parallel sessions (human or agent), each owning a disjoint set of paths. **Read [`prompts/_shared-rules.md`](prompts/_shared-rules.md) first**: it holds the ownership rules, the definition of done and the security rules. Who owns what is in [`docs/09-execution-plan.md`](docs/09-execution-plan.md) §2 and §4 and in [`.github/CODEOWNERS`](.github/CODEOWNERS).

## Toolchain

- Node 24 (`.nvmrc`; `nvm use` or `fnm use`), pnpm 12 pinned by `packageManager` in `package.json` (`corepack enable` picks it up).
- Before every push: `pnpm i && pnpm -w typecheck && pnpm -w lint && pnpm -r test`. CI runs the same on macOS and Ubuntu, plus the protocol codegen freshness check and the Swift build of `apps/mac-helper`.
- **Lint and format: Biome only.** One fast native binary does formatting, linting and import sorting with a single config (`biome.json`), so there is no ESLint + Prettier plugin sprawl or rule conflicts to manage. Fix with `pnpm lint:fix`; the editor extension is recommended in `.vscode/extensions.json`.
- **Tests: Vitest.** No network in CI: record fixtures, and put live tests behind `PSYCHE_LIVE_TESTS=1`.

## Worktrees and branches

One worktree per session, one branch per worktree, named `ws/<id>-<name>`:

```sh
git fetch origin
git worktree add ../psyche-s05 -b ws/s05-permissions origin/main
```

Rebase on `main` at least daily. Commit early and often with [Conventional Commits](https://www.conventionalcommits.org/) (`feat(permissions): bind approvals to argv+cwd`, `fix(db): ...`, `docs: ...`).

## Pull requests

- Keep PRs small: under ~800 changed lines (generated files and the lockfile aside).
- Title prefix `[<id> <name>]`, for example `[S05 permissions] feat(permissions): bind approvals to argv+cwd`.
- Fill in the checklist from `.github/pull_request_template.md`.
- Add a changeset with `pnpm changeset` for any package change.
- Keep `docs/status/<id>.md` current (what works, what is stubbed, blockers, requests to other sessions); start your work with a plan at `docs/plans/<id>.md`.

## Protocol changes

`packages/protocol` is the contract every package compiles against. Change it only through a PR titled `protocol: <summary>`:

- Additive only until v1: new optional fields, new methods, new events. Renames and removals need the integrator's sign-off.
- Update the matching fake in `packages/testing/src/fakes/` in the same PR.
- Describe the change in `packages/protocol/CHANGES.md`.
- Run `pnpm protocol:gen` and commit the generated files (CI runs `pnpm protocol:check` and fails on stale output).
- The integrator merges protocol PRs first; keep working against your local copy until it lands.

## Database migrations

Add migrations only for the tables your package owns ([`docs/04-data-model.md`](docs/04-data-model.md)), as `packages/db/migrations/<YYYYMMDDHHMM>_<package>_<desc>.sql`. Never edit a migration that has merged; add a new one.

## Merge order

The integrator (S00) merges in this order: `protocol:` PRs, then `packages/db`, then `packages/testing`, then libraries, then apps. Other PRs are rebased after a protocol merge.

## Security

No telemetry, and no secrets in code, logs, fixtures or model-visible text; every side effect goes through the Permission Broker. See [`docs/05-security-and-permissions.md`](docs/05-security-and-permissions.md). To report a vulnerability, follow [`SECURITY.md`](SECURITY.md), not a public issue.
