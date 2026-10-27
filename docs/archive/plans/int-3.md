# INT-3 plan: Milestone 1 acceptance and hardening

Prompt: [prompts/int-3-acceptance.md](../prompts/int-3-acceptance.md). Branch `int/3-acceptance`. Owns `tests/acceptance/**`, `docs/release-notes/**`, `docs/status/int-3.md`.

## Goal

Decide whether Milestone 1 is done (docs/08 "Acceptance", docs/03 "Cross-cutting acceptance criteria") with evidence: a scorecard per check, per scenario, per model and per run, every failure triaged to an owner, and the live gates runnable the moment model keys exist.

## Steps

1. **Offline first** (scripted provider, fixtures, no network), recorded in `tests/acceptance/SCORECARD.md`:
   - V1 / V2 / V7 through S18's scripted scenario runner (`pnpm check:scenarios`).
   - The injection corpus in `balanced`, `manual` and `auto` against S18's reference stack and INT-2's real stack (browser, Google connector, broker on SQLite).
   - The secret-leak checker over every model-visible capture the acceptance runs produce (`PSYCHE_CAPTURE_DIR` + `pnpm check:secrets --captures`).
   - The resumability harness on the real stack (SQLite task engine, worker pool, agent loop, broker) with scripts derived from the three scenarios: 25 seeded random kill points (8 + 8 + 9, the scenarios' `randomKills`), invariants checked after every kill.
2. **Performance budgets** with the scripted provider where a hosted model is not needed: Gateway boot and first delta, browser snapshot over the CDP bridge mock, memory search on a seeded workspace. "Cold start to first token with a hosted model" is a live measurement and stays "needs live model".
3. **Accessibility** of the main flows as rendered by the desktop (the kit's screens inside S11's shell): keyboard operation, accessible names on cards, reduced motion. Automated with jsdom, axe-core and user-event in `tests/acceptance/a11y/`; the VoiceOver walk-through itself needs a human and is listed as such.
4. **Live gates** behind `PSYCHE_LIVE_TESTS=1`: V1 / V2 / V7 on one Anthropic, one OpenAI and one local `agent-capable` model, three runs each, through a live-mode driver over S18's scenario stack (same fakes and clock, real model, `liveSeverity` honored). Scorecard rows stay "not run: key needed" until keys exist.
5. **Triage**: every failure gets an owner, a failing test or an issue; one-line integration fixes only outside `tests/acceptance`.
6. **Release notes** `docs/release-notes/0.1.md` for `v0.1.0-alpha`; `docs/status/int-3.md` with the scorecard summary.

## Interfaces used

- `@psyche/testing`: `runAllScenarios`, `loadCorpus` / `runCorpus` / `referenceStack`, `exploreKillPoints` / `runWithKill`, `scanCaptures`, `fixtureSecrets`; the scenario `Stack` by relative path for the live driver (additive seam: `StackOverrides.provider`).
- `tests/integration`: `startSkeleton` (walking skeleton over the composed Gateway), `prepareInt2` (injection rig), `MockDesktop` + `CdpBridgeDriver` for the snapshot timing.
- `@psyche/ui`: `ApprovalCard`, `QuestionCard`, `Checklist`, `WrapUpBox`, `Composer`, `OnboardingFlow`, `ThemeProvider`.
- `apps/gateway/compose`: `modelSetupFromEnv` for the live model.

## Risks

- The committed injection corpus has 0 cases (S18 is blocked on authoring); the corpus rows can only cover the README's worked example until cases land.
- The resumability harness runs one Task per script with a compliant model; scenario steps that expect a denial, an expiry or a tampered argument are not resumability material and are left to the scripted runner.
- Live runs need `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and a local Ollama; none exist on this machine, so the live driver is exercised with the scripted provider only.
- The machine is under load (two crashes today): no Electron packaging in this session, at most two subagents, short turns.
