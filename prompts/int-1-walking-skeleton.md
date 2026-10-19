# Integration 1 — The walking skeleton

You are building Psyche (read `README.md`). You are **INT-1**, the first integration session. Start only when `docs/status/integration-readiness.md` (written by S00) says that `apps/gateway`, `apps/desktop`, `packages/agent-core`, `packages/model-router`, `packages/permissions`, `packages/memory`, `packages/ui` and `packages/viewers` have merged with green CI. Work in your own worktree on branch `int/1-walking-skeleton`. You may edit composition and wiring code in `apps/gateway/src/compose/**`, `apps/desktop/src/compose/**`, `apps/web/src/compose/**` and integration tests under `tests/integration/**`; for anything else, open a small PR against the owning package and note it in `docs/status/int-1.md`.

## Read first
`prompts/_shared-rules.md`; `docs/02-architecture.md` §3, §4.2; `docs/03-feature-spec.md` rows R1, E1–E4, C4, C5, F2, F3, H1, H2, H7, D2, D4, D5; `docs/06-ui-design.md` (main window, chat anatomy, approval and question cards, agent sheet); every `docs/status/*.md`.

## Goal
Replace fakes with real packages along one path and make this scenario pass on a Mac with a hosted model and with one local model: install → onboarding names the agent and writes `IDENTITY.md`/`SOUL.md`/`USER.md` → first chat turn streams → the agent reads a file in a granted folder (read tool) and proposes a write → an approval card appears outside the chat, the user approves "Allow once" → the write happens with a receipt line → the agent asks a structured question with chips → the answer resumes the turn → the pinned checklist updates → the wrap-up box offers a next step → quitting the window keeps a delegated background task running (visible in Activity on relaunch) → memory flush writes today's daily note → Soul & Memory shows and edits the files → "Download your data" exports.

## Work
1. Composition roots: wire `agent-core` with `model-router`, `permissions`, `memory`, `audit`, `tasks` (real where merged), register built-in tools and the `view.*` handlers, mount API handlers from each package, start the scheduler if merged.
2. Desktop: connect the real Gateway, mount `packages/ui` screens and `packages/viewers`, LaunchAgent handoff for background continuation, notification relay via the helper if merged.
3. Write the end-to-end test under `tests/integration/walking-skeleton/` using Playwright-for-Electron against a real Gateway with the scripted fake model provider (for CI) and with a live model behind `PSYCHE_LIVE_TESTS=1`.
4. Fix integration bugs in place when they are wiring; file precise issues (with failing tests) to owners otherwise.
5. Record cold-start, first-token and snapshot timings against the budgets in `docs/03` (cross-cutting criteria).

## Definition of done
The scenario passes in CI with the scripted provider and manually with Anthropic, OpenAI and one `agent-capable` local model; `docs/status/int-1.md` lists remaining gaps per package; `README.md` gains a "Run the skeleton" section.
