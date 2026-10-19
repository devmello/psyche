# INT-1 plan: walking skeleton

**Goal.** Replace fakes with the real packages along one path and make the scenario in `prompts/int-1-walking-skeleton.md` pass with a scripted model in CI and with live models by hand.

**Steps.**
1. Write `docs/status/integration-readiness.md` (what is on `main`, what INT-1 needs from open PRs).
2. Gateway hook for package handlers (small PR to S01, #45).
3. Composition root `apps/gateway/src/compose/`: loop, router, broker, audit, memory, tasks, scheduler, notifier; mount handlers; forward events; boot `psyched` through it.
4. `tests/integration/walking-skeleton/`: harness (composed Gateway + desktop client), scripted model, scenario test, live test behind `PSYCHE_LIVE_TESTS=1`.
5. File non-wiring issues to owners; record timings and gaps in `docs/status/int-1.md`.
6. After #27 lands: mount the screens and add the Playwright-for-Electron spec (#51).

**Interfaces.** `startGateway({ handlers })`; `composeGateway(options) → ComposedGateway`; `modelSetupFromEnv(env)`; `writeOnboarding(call, answers)`.

**Risks.** Package APIs disagree at the seams (found: `task.start` side effect, answer tokens); live models word turns differently (the live test checks outcomes, not blocks); the UI kit is still a draft.
