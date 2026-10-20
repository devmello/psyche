---
title: Pull requests
---

# Pull requests

Psyche merges many small pull requests a day from parallel workstreams. To keep that fast, a pull request merges as soon as its quick checks pass, and the full test suites run in batches afterwards. This page explains how to name and shape a pull request, what the merge gate checks, what happens after merge, and the security checks every change is held to. The binding rules are in [prompts/_shared-rules.md](https://github.com/devmello/psyche/blob/main/prompts/_shared-rules.md).

## Branches and commits

- Work in your own git worktree, on one branch named `ws/<id>-<name>`, for example `ws/s05-permissions`.

  ```bash
  git fetch origin
  git worktree add ../psyche-s05 -b ws/s05-permissions origin/main
  ```

- Commit early and often with [Conventional Commits](https://www.conventionalcommits.org/): `feat(permissions): bind approvals to argv+cwd`, `fix(db): …`, `docs: …`.
- Bring in new work from `main` at least daily.

## Shape of a pull request

- **Small.** Under about 800 changed lines, not counting generated files and the lockfile.
- **Titled** `[<id> <name>] <conventional commit summary>`, for example `[S05 permissions] feat(permissions): bind approvals to argv+cwd`.
- **Checklist.** Fill in [.github/pull_request_template.md](https://github.com/devmello/psyche/blob/main/.github/pull_request_template.md): what and why, the feature ids from [docs/03](https://github.com/devmello/psyche/blob/main/docs/03-feature-spec.md), the definition of done, the security rules and ownership.
- **Changeset.** Add one with `pnpm changeset` for any package change.
- **Docs.** If you change behavior a document in `docs/` describes, update the document in the same pull request. Keep your `docs/status/<id>.md` current.
- **Ownership.** Edit only the paths you own. See [Contributing](/contributing/).

### Protocol changes

`packages/protocol` is the contract every package compiles against. Change it only in a separate pull request titled `protocol: <summary>`:

1. Make the change additive: new optional fields, new methods, new events. No renames or removals before v1.
2. Update the matching fake in `packages/testing/src/fakes/`.
3. Describe it in `packages/protocol/CHANGES.md`.
4. Run `pnpm protocol:gen` and commit the generated files. CI fails on stale output.

The integrator merges protocol pull requests first.

### Database migrations

Add migrations only for the tables your package owns ([docs/04](https://github.com/devmello/psyche/blob/main/docs/04-data-model.md)), named `packages/db/migrations/<YYYYMMDDHHMM>_<package>_<desc>.sql`. Never edit a migration that has merged; add a new one.

## Before you open it

Run the cheap checks locally:

```bash
pnpm -w typecheck
pnpm exec biome check .
pnpm --filter <your-package> exec vitest run --maxWorkers=2
```

Run only the tests you changed, and only where they are cheap. Do not run the full workspace suite, the Electron end-to-end tests, real-browser proofs, containers, VMs or local models before a pull request; those run later in batches. Use a subagent or a second reader to review your own diff before you open it.

## The merge gate

On every pull request, CI runs one fast job on Linux ([.github/workflows/ci.yml](https://github.com/devmello/psyche/blob/main/.github/workflows/ci.yml)):

- a secret grep gate over the tree (`scripts/ci/secret-grep.sh`);
- `pnpm -w typecheck`;
- `pnpm -w lint`;
- the protocol codegen freshness check, when the title says `protocol`.

A pull request merges as soon as it has no conflicts and this check is green. Nobody runs package tests per pull request. It is held only when lint or typecheck is red, or when a conflict cannot be resolved cleanly.

### Resolving conflicts

When `main` has moved and your branch conflicts:

1. Merge `origin/main` into your branch.
2. Resolve the conflicts.
3. Run `pnpm -w typecheck` and `biome check`.
4. Push. The pull request merges when the gate is green.

Never squash your branch with `git reset --soft` onto a `main` that has moved since you branched. The reset makes your commit undo everything that landed on `main` in between, and it has silently reverted other people's work in this repository before. Merge instead.

## After merge: batched tests

- Every push to `main` runs the full test suite on Linux.
- After a merge queue drains, the integrator runs the touched packages' tests once against `main`.
- Failures go into [docs/status/known-red.md](https://github.com/devmello/psyche/blob/main/docs/status/known-red.md) with the date, the job, the failing test and the suspected owner. Owners fix them in one round.
- macOS, desktop, security and release workflows run on demand, nightly, or on release tags.

If a test of yours shows up in `known-red.md`, fixing it comes before new work.

## Security review

Every change is held to the rules in [docs/05](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md). The pull request template asks you to confirm them: no secret in model-visible text, logs or transcripts; every side effect through the Permission Broker with a receipt; approvals bound to exact arguments and expiring; untrusted content treated as data; no host-shell fallback; loopback bind; no telemetry.

On top of that:

- **Review duty.** The security-harness workstream reviews every pull request that touches `permissions`, `vault`, `browser`, `sandbox`, `channels` or `mcp-host`, maps the change to the docs/05 sections it affects, and files findings as issues with a failing test case. An adversarial-review workstream red-teams the brokers.
- **Threat-model reviews** per milestone record what docs/05 promises against what the code does; the latest is [reports/m3-threat-model-review.md](https://github.com/devmello/psyche/blob/main/reports/m3-threat-model-review.md).

### Injection corpus and secret-leak checks

The security workflow ([.github/workflows/security.yml](https://github.com/devmello/psyche/blob/main/.github/workflows/security.yml)) runs nightly, on demand and on release tags:

| Job | Checks |
| --- | --- |
| `security / secret-leak` | `pnpm audit` for high and critical advisories; no fixture secret or card, ID or key pattern in tracked files; every package's tests with model-visible capture on, then no secret in any captured prompt, tool result, transcript, log, card or receipt |
| `security / corpus-and-scenarios` | The injection corpus and the acceptance scenarios are well-formed |
| `security / injection-corpus` | Every injection case against the current stack (`pnpm check:injection`) |
| `security / scenarios-scripted`, `security / resumability` | Acceptance scenarios on a scripted model; kill-and-restart without duplicate side effects |

If your change touches a tool, the broker, a channel or anything that reads untrusted content, run these locally before you open the pull request:

```bash
pnpm check:injection
pnpm check:secrets --repo
```

Known failures are pinned in `tests/corpus/injection/known-failures.json` with an issue and an owner. The run fails on a new failure, and also on a pin that passes again, so remove the pin when you fix it. To add an injection case, follow [tests/corpus/injection/README.md](https://github.com/devmello/psyche/blob/main/tests/corpus/injection/README.md): fictional domains only, and never a real person or working exploit infrastructure.

Dependabot opens grouped weekly updates for Actions, npm and Docker images; they go through the same gate.

## Learn more

- [Contributing](/contributing/)
- [Architecture](/contributing/architecture)
- [Untrusted content and taint](/security/taint)
- [prompts/_shared-rules.md](https://github.com/devmello/psyche/blob/main/prompts/_shared-rules.md)
- [CONTRIBUTING.md](https://github.com/devmello/psyche/blob/main/CONTRIBUTING.md)
- [docs/09-execution-plan.md](https://github.com/devmello/psyche/blob/main/docs/09-execution-plan.md)
