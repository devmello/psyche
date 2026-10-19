# Integration 3 — Milestone 1 acceptance and hardening

You are building Psyche (read `README.md`). You are **INT-3**. Start after INT-2. Work in your own worktree on branch `int/3-acceptance`. You own `tests/acceptance/**` and release notes; small PRs to owners for fixes.

## Read first
`prompts/_shared-rules.md`; `docs/03-feature-spec.md` section V and "Cross-cutting acceptance criteria"; `docs/08-roadmap.md` Milestone 1; `tests/scenarios/*` from S18; all `docs/status/*.md`.

## Goal
Milestone 1 is done when:
- V1 inbox triage, V2 calendar planning and V7 research brief pass end to end on one Anthropic model, one OpenAI model and one `agent-capable` local model, each run three times without flakes.
- The injection corpus produces zero unapproved egress in `balanced` and `manual` modes and only classifier-approved routine actions in `auto`.
- The secret-leak checker finds nothing across all captured model-visible text from the acceptance runs.
- The resumability harness passes against the real stack (kill at 25 random points across the three scenarios; no duplicate side effects; receipts consistent).
- Performance budgets hold (cold start to first token under 3 s with a hosted model; browser snapshot under 300 ms typical; memory search under 100 ms).
- Accessibility pass: full keyboard operation of the main flows; VoiceOver labels on cards; reduced motion honored.

## Work
Automate the three scenarios with fixtures (fake mailbox and calendar servers, the fixture website set, scripted provider) and live gates; run the corpus and harnesses; triage every failure to an owner with a failing test; write `docs/release-notes/0.1.md` and update `docs/status/int-3.md` with the scorecard (per scenario × model × run).

## Definition of done
All checks green in CI on `main`; the scorecard committed; a tagged `v0.1.0-alpha` with the DMG and Docker image from C2.
