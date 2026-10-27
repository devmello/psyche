<!--
Title: `[<id> <name>] <conventional commit summary>`, for example `[S05 permissions] feat(permissions): bind approvals to argv+cwd`.
Protocol changes: `protocol: <summary>` (the integrator merges these first).
Rules: docs/archive/prompts/_shared-rules.md (history, kept for reference). Process: CONTRIBUTING.md.
-->

## What and why

<!-- One paragraph. Link the feature ids from docs/03-feature-spec.md (for example F2, I6) and the doc sections this implements. -->

Session: <!-- S05 -->
Feature ids: <!-- F1, F2 -->

## Definition of done

- [ ] `pnpm -w typecheck`, `pnpm -w lint` and `pnpm -r test` pass locally (CI runs the same on macOS and Ubuntu)
- [ ] Contract tests for every interface this PR implements (`packages/testing` conformance suite); unit tests for the logic
- [ ] No network in CI: fixtures are recorded; live tests sit behind `PSYCHE_LIVE_TESTS=1`
- [ ] Package `README.md` covers purpose, public API, mapping to the docs, and what is stubbed
- [ ] New or changed dependency versions verified with `npm view <pkg> version` (and peer requirements); licenses checked, no GPL/AGPL
- [ ] Docs in `docs/` updated in this PR if behavior they describe changed
- [ ] A changeset is added (`pnpm changeset`) or this PR changes no package

## Security rules (docs/05-security-and-permissions.md)

- [ ] No secret in model-visible text, logs or transcripts (`{{cred:slug}}` placeholders; the vault resolves them in executors)
- [ ] Every side-effecting action goes through `PermissionBroker` and records a receipt
- [ ] Approvals are bound to exact arguments and expire
- [ ] Untrusted content (web, email, documents, non-owner messages, MCP results) is data with provenance `untrusted`, never instructions
- [ ] No host-shell fallback from the sandbox; the Gateway binds to loopback
- [ ] No telemetry, no CAPTCHA solving, no stored card numbers
- [ ] Not applicable: this PR touches none of the above (say why)

## Ownership and contracts

- [ ] Only paths owned by my session are edited (`docs/09-execution-plan.md` §2, `.github/CODEOWNERS`)
- [ ] Cross-package dependencies go through `packages/protocol/src/contracts/` and are tested against fakes; no import of another session's unmerged branch
- [ ] Database migrations touch only my own tables and are named `packages/db/migrations/<YYYYMMDDHHMM>_<package>_<desc>.sql`

### Protocol PRs only (`protocol:` prefix)

- [ ] Additive only (new optional fields, methods or events; no renames or removals before v1)
- [ ] Fake in `packages/testing/src/fakes/` updated in this PR
- [ ] Change described in `packages/protocol/CHANGES.md`
- [ ] `pnpm protocol:gen` run and generated files committed (`pnpm protocol:check` passes)

## Size

- [ ] Under ~800 changed lines (excluding generated files and the lockfile), or the reason it is larger is stated here

## Notes for reviewers

<!-- Stubs, follow-ups, open questions, anything the integrator should know. -->
