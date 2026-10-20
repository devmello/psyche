# tests/acceptance

**Owner:** INT-3. Milestone 1 acceptance (prompts/int-3-acceptance.md): the checks behind [SCORECARD.md](SCORECARD.md). Criteria: docs/03-feature-spec.md "Cross-cutting acceptance criteria" and section V; docs/08-roadmap.md Milestone 1. Scenarios and fixtures belong to S18 (tests/scenarios); this package automates them.

```
offline/   scenarios.test.ts     V1, V2, V7 through S18's scripted runner; known failures stay tracked by issue
           scenarios-m2.test.ts  V5, V6, V8, V9 (scenarios-m2/) through the same runner, plus fake-side checks
           scenarios-m2-format.test.ts  the M2 scenario files pass S18's validator
           injection.test.ts     the injection corpus in balanced, manual and auto on the reference and INT-2 stacks
           resumability.test.ts  the happy paths killed at seeded random points on the real stack (25 for V1, V2, V7; 16 for M2)
scenarios-m2/                    the Milestone 2 scenarios in S18's format (README there: provisional tools, decisions, findings)
perf/      budgets.test.ts       Gateway boot and first delta, browser snapshot, memory search (scripted provider)
a11y/      main-flows.test.tsx   axe-core, keyboard operation and reduced motion over the kit's main-flow screens (jsdom)
live/      driver.ts             live-mode driver over S18's scenario Stack: real model, same fakes and clock
           driver.test.ts        the driver's plumbing, checked in CI with the scripted provider
           scenarios.live.test.ts  the live gates (PSYCHE_LIVE_TESTS=1)
           tool-specs.ts         descriptions and schemas a live model needs for the scenario tools
src/       scenario-scripts.ts   scenario.json → resumability scripts, tools and policy
           m2-world.ts           the M2 scenarios' fakes and built-in services (StackOverrides.impls / .services)
           report.ts             out/acceptance/*.json writers
scripts/   offline.ts            the whole offline pass with capture on + secret-leak check + SCORECARD.md
           make-m2-fixtures.ts   rebuilds V5's fillable PDF and its hashes in the mailbox fixture
```

## Running

```bash
pnpm --filter @psyche/acceptance-tests test        # everything CI runs (also part of `pnpm -r test`)
pnpm --filter @psyche/acceptance-tests offline     # same, with captures + `check:secrets`, then rewrites SCORECARD.md
```

Results land in `out/acceptance/*.json` (git-ignored). The scorecard is regenerated from them; commit it with the run it describes.

## Live gates

One model per invocation; the scorecard wants one hosted Anthropic model, one hosted OpenAI model and one local `agent-capable` model, three runs each (`PSYCHE_LIVE_REPEATS`, default 3). The default scenario list is all eight: V1, V2, V3 and V7 from tests/scenarios, and V5, V6, V8 and V9 from `scenarios-m2/` with their fakes. Run them one at a time with `PSYCHE_LIVE_SCENARIOS=<id>` to keep partial results.

Before the first run the suite sends the provider one tiny request. A refused key or an unreachable model fails there with the provider's reason (credentials redacted), and the reason is recorded in the model's report so the scorecard can say why nothing ran.

```bash
PSYCHE_LIVE_TESTS=1 PSYCHE_MODEL=anthropic/claude-sonnet-5-5 ANTHROPIC_API_KEY=… pnpm --filter @psyche/acceptance-tests live
PSYCHE_LIVE_TESTS=1 PSYCHE_MODEL=openai/gpt-6-luna OPENAI_API_KEY=… pnpm --filter @psyche/acceptance-tests live
ollama pull qwen3.5:9b   # spike 05 (PR #76): agent-capable with reasoning off
PSYCHE_LIVE_TESTS=1 PSYCHE_MODEL=ollama/qwen3.5:9b pnpm --filter @psyche/acceptance-tests live
pnpm --filter @psyche/acceptance-tests offline -- --scorecard-only   # fold the live reports into SCORECARD.md
```

| Variable | Meaning |
| --- | --- |
| `PSYCHE_LIVE_TESTS=1` | opt in; without it the live file is skipped |
| `PSYCHE_MODEL=<provider>/<model>` | `anthropic`, `openai`, `google`, `openrouter` or `ollama` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY` | the hosted provider's key (read by `modelSetupFromEnv`, never model-visible) |
| `PSYCHE_OLLAMA_URL` | a non-default Ollama (default `http://127.0.0.1:11434`) |
| `PSYCHE_UTILITY_MODEL` | utility model ref (default: the primary) |
| `PSYCHE_LIVE_REPEATS` | runs per scenario (default 3) |
| `PSYCHE_LIVE_SCENARIOS` | comma-separated scenario ids (default all three) |

Each run writes `out/acceptance/live-<provider>-<model>.json` with the hard and soft results, the steps and every tool call. Hard assertions (security, correctness) fail the run; soft ones (quality) are counted.

### How live mode differs from scripted mode

The driver (`live/driver.ts`) uses S18's `Stack` (real agent loop, Permission Broker, audit chain; fixture Gmail, Calendar, search, sites; frozen clock) with a real model behind `StackOverrides.provider`. A live model chooses its own call ids, card order, wording and questions, so the driver is model-agnostic:

- steps limited to `scripted` are skipped, and so are the `approve` steps that answer them;
- every assertion runs at `liveSeverity ?? severity`;
- scripted call ids (`callRef`) never match a live call. An `approval_requested` assertion picks its card among the step's cards by kind, tool, target and `mustShow` (preferring a card that shows every string, then the latest); the card it binds and the live call behind it stand in for the scripted ids in later assertions, `approve` steps and `fault` steps;
- **sibling cards** (same kind and tool as an expected card, in the same step, e.g. one draft card per email where the script had one) do not count against `max`; the `approve` step answers them with the same decision and scope as the expected card. Every other unexpected card gets the scenario's `approverPolicy` (V1 and V2: deny);
- an `approve` step whose assertion is soft in live mode and matched nothing is skipped and reported; a `stale` answer must be refused as re-issued;
- `ask_user` questions are answered at once from `live/answers.ts` (a rule per scenario by header or question pattern; default: the first option, a list of it for multi-select), never waited out;
- `harness.live.stepTimeoutSeconds` and `maxToolCallsPerStep` cancel a runaway run and fail the step;
- after `restart_gateway` the parked call is replayed from the driver's records (security §3.7), not asked of the model again, so the re-issued card is the one it waits on;
- the scenario tools get real descriptions and schemas (`live/tool-specs.ts`) and the first owner message carries the session context (owner, zone, clock, connected accounts);
- the report records every card (id, kind, tool, summary, scopes, status, re-issue link, details without message bodies), every answer (step, sibling, policy or stale, with the broker's verdict) and every question with the answer given, so a failed run is triaged from `out/acceptance/live-<model>.json` alone. Partial runs (`PSYCHE_LIVE_SCENARIOS`) replace their scenarios' rows in that file and keep the rest.

## What is stubbed or not covered here

- The committed injection corpus has 0 cases (S18 blocked on authoring); the corpus rows cover the README's worked example only.
- The resumability sweep runs each scenario's happy path (every call the owner lets through). Denials, expiry, tampered arguments and hijacked probes are the scripted runner's business.
- "Cold start to first token with a hosted model" and the live gates need model keys.
- VoiceOver itself is a manual check on the packaged app.
