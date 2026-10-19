# INT-3 status: Milestone 1 acceptance (2026-10-19)

Branch `int/3-acceptance`. Plan: [docs/plans/int-3.md](../plans/int-3.md). Scorecard: [tests/acceptance/SCORECARD.md](../../tests/acceptance/SCORECARD.md) (generated; evidence in `out/acceptance/*.json`). Release notes draft: [docs/release-notes/0.1.md](../release-notes/0.1.md). Package: [tests/acceptance/README.md](../../tests/acceptance/README.md).

## Verdict

Milestone 1 is **done offline and not yet done live**. Every check that runs without a hosted model passes on `main` with the scripted provider and fixtures; the live gates (three scenarios × Anthropic, OpenAI and a local `agent-capable` model × three runs) are wired and runnable but have not been run, because this machine has no model keys and no Ollama. Do not tag `v0.1.0-alpha` until they pass and PR #60 (S22 CLI / deploy) is merged.

## What passed

| Check | Result | Where |
| --- | --- | --- |
| V1 inbox triage, scripted | 49/49 hard, 6/6 soft | `tests/acceptance/offline/scenarios.test.ts` (S18's runner) |
| V2 calendar planning, scripted | 47/47 hard, 6/6 soft | same |
| V7 research brief, scripted | 23/25 hard, 7/7 soft; the 2 failures are #69 (tracked in `tests/scenarios/known-failures.json`) | same |
| Injection corpus, `balanced` / `manual` / `auto`, S18 reference stack | 0 executed, 0 fail, 3 warn (reference names its mode default instead of `taint:new_target`) | `offline/injection.test.ts` |
| Injection corpus, `balanced` / `manual` / `auto`, INT-2 real stack (browser, Google connector, broker on SQLite) | 0 executed, 0 unexplained fail; `manual` has one pinned failure (below) | same |
| Secret-leak checker over every capture of the acceptance runs (prompts, tool results, transcripts, logs, cards, receipts) | 0 hits | `pnpm --filter @psyche/acceptance-tests offline` → `check:secrets --captures` |
| Resumability on the real stack (SQLite task engine, worker pool, agent loop, broker, receipts): V1 happy path at 8 of 51 kill points, V2 at 8 of 34, V7 at 9 of 41, seeded | 25/25 clean: no duplicate side effect, receipts consistent, re-issued cards, uncertain steps reconciled | `offline/resumability.test.ts` |
| Hash-chained audit log | verifies after every scenario | built into the runners |
| Gateway boot + pairing + first delta (scripted provider) | under 60 ms on this Mac (boot ≈ 40–50 ms, first delta 4 ms) | `perf/budgets.test.ts` |
| Browser snapshot, 123-ref article page over the CDP bridge mock | 4 ms median (budget 300 ms) | same |
| Memory search, 1,865 chunks (a year of daily notes + 40 files) | 0.4 ms median (budget 100 ms) | same |
| Accessibility: axe-core on approval card, question card, checklist, wrap-up, chat screen (thread + dock + composer), onboarding, rail; keyboard operation (heading focus, Return never approves, ⌘Return / ⌘D, Tab order, question answers, onboarding Next, Escape stops); reduced motion (`prefers-reduced-motion` and the explicit setting, stylesheets) | 13/13 | `a11y/main-flows.test.tsx` (jsdom) |
| Live driver plumbing (the live code path with the scripted provider, all three scenarios) | matches the scripted runner | `live/driver.test.ts` |

## What failed or is pinned, with owner

| Finding | Owner | Where it is tracked |
| --- | --- | --- |
| V7: the owner's standing `site` grant is ignored for reads in a tainted turn, so `energy-agency.example` asks once more than it should | S05 | #69; `tests/scenarios/known-failures.json` |
| Injection worked example in `manual`: the corpus expects scopes `once,task`, security §3.2 says manual-mode destructive actions offer `once` only, which the broker does. The corpus case is wrong, not the broker | S18 (corpus fix) | pinned in `tests/acceptance/offline/injection.test.ts` and INT-2's `tests/integration/injection/injection.test.ts` |
| The committed injection corpus has 0 cases; CI runs the README's worked example only | S18 / owner (authoring blocked, docs/status/s18.md) | scorecard row "Injection corpus size: BLOCKED" |
| The scenario tools are registered with placeholder descriptions and open schemas (`world.ts`), unusable by a real model | S18 | overlaid by `tests/acceptance/live/tool-specs.ts`; request below |

No new issue was needed: every failure already had one, or is a corpus / fixture fix.

## What still needs a live model

- The live gates: `PSYCHE_LIVE_TESTS=1 PSYCHE_MODEL=<provider>/<model> pnpm --filter @psyche/acceptance-tests live`, once per model. Variables the user must set:
  - `ANTHROPIC_API_KEY` with `PSYCHE_MODEL=anthropic/<model>` (e.g. `anthropic/claude-sonnet-5-5`);
  - `OPENAI_API_KEY` with `PSYCHE_MODEL=openai/<model>` (e.g. `openai/gpt-6-luna`);
  - a running Ollama with the model pulled and `PSYCHE_MODEL=ollama/qwen3.5:9b` (spike 05, PR #76: reasoning off), `PSYCHE_OLLAMA_URL` if not the default;
  - optional `PSYCHE_UTILITY_MODEL`, `PSYCHE_LIVE_REPEATS` (default 3), `PSYCHE_LIVE_SCENARIOS`.
  Then `pnpm --filter @psyche/acceptance-tests offline -- --scorecard-only` folds `out/acceptance/live-*.json` into the scorecard.
- "Cold start to first token under 3 s with a hosted model": the Gateway's share is under 60 ms; the rest is model latency, measured by the live runs.
- INT-1's and INT-2's own live tests (`tests/integration/**/live.test.ts`), same variables plus `PSYCHE_GOOGLE_CLIENT_ID` for real Google.

## Manual checks not done here

- VoiceOver walk-through of the packaged app (rotor order, announcement of new cards). The automated pass covers names, roles, focus and keyboard paths; the screen reader itself needs a person.
- The Electron smoke tests (`desktop` CI job) were not rerun in this session: the machine crashed twice today under load, so nothing here packages Electron.

## How live mode works (for whoever runs it)

`tests/acceptance/live/driver.ts` drives S18's scenario `Stack` (real agent loop, Permission Broker, audit chain; fixture Gmail, Calendar, search and sites; frozen clock) with a real model behind a new additive seam, `StackOverrides.provider`. Steps limited to `scripted` are skipped; assertions run at `liveSeverity ?? severity`; `approve` steps answer the card their assertion bound, or are skipped when the assertion is soft and nothing matched; `stepTimeoutSeconds` and `maxToolCallsPerStep` from `harness.live` cancel a runaway run; after `restart_gateway` the parked call is replayed from the driver's records (security §3.7), never re-asked of the model; tools get real descriptions and schemas and the first message carries the session context. The same driver with a `FakeModelProvider` reproduces the scripted outcomes (`live/driver.test.ts`), which is what CI checks.

Expect soft failures on a live model where the scenario pins wording (`transcript_mentions`) or exact card order; the hard set (no unapproved egress, approvals with full arguments, binding and expiry, receipts, secrets, taint) is what gates.

## Requests to other sessions

- **S18**: (1) fix the worked example's `scopesOffered` for `manual` (`once` only) or add `byMode`; (2) give `tests/scenarios/shared/tools.json` a `description` and `inputSchema` per tool and have `world.ts` register them, so `tests/acceptance/live/tool-specs.ts` can go away; (3) the `StackOverrides.provider` seam in `packages/testing/src/scenarios/stack.ts` (18 lines, additive, plus `args` from `details.paramsRedacted` for live calls) is yours to review.
- **S05**: #69 (standing site grant in a tainted turn).
- **S00**: `pnpm-workspace.yaml` and the root `vitest.config.ts` list `tests/acceptance`; CI's `pnpm -r test` therefore runs the offline checks on every PR (≈ 10 s). No workflow change was needed. Consider a required status for it when the live gates have run once.
- **S22**: merge #60, then the release notes' "run it on a server" paragraph is true on `main`.

## Ownership notes

Outside `tests/acceptance/**`, `docs/release-notes/**`, `docs/plans/int-3.md` and this file, INT-3 changed:

- `packages/testing/src/scenarios/stack.ts` (S18): the `provider` override and live-call arguments, described above.
- `pnpm-workspace.yaml`, `vitest.config.ts`, `pnpm-lock.yaml` (S00): the new workspace package.
