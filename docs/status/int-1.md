# INT-1 status: walking skeleton (2026-10-19)

Branch `int/1-walking-skeleton`. Plan: [docs/plans/int-1.md](../plans/int-1.md). Readiness: [integration-readiness.md](integration-readiness.md).

## What works

- **Composition root** `apps/gateway/src/compose/`: `composeGateway()` builds the real agent loop (`agent-core`), model router or an injected provider, Permission Broker with the SQLite store, hash-chained audit log, memory store with flush, task engine and worker pool, scheduler and notifier, and starts the Gateway with them. `psyched` (`apps/gateway/src/main.ts`) boots through it, with the model from `PSYCHE_MODEL` (keys from the provider's env variable; vault-backed keys come with S03/S06). Without a model it starts and answers turns with "No model is configured yet".
- **Mounted handlers**: `approvals.*`, `grants.*`, `questions.*`, `memory.*`, `tasks.*`, `automations.*`, `notifications.*` (through `startGateway({ handlers })`, PR #45 to S01).
- **Events forwarded to the bus**: `approval.updated`, `receipt.created`, `memory.*`, `task.*`, `automation.*`, `notification.*`.
- **Answer tokens** reach the right surface through `approvals.get` / `approvals.list` (`compose/approval-tokens.ts`; see #50).
- **Folder grants**: `permissions.policy` is applied to the broker at boot and on every `settings.changed`.
- **Onboarding writes** `@psyche/web/compose/onboarding` `writeOnboarding()`: IDENTITY.md (name, creature, tagline), USER.md (name, timezone), SOUL.md when a preset is chosen.
- **The UI kit in the app** (`apps/web/src/compose/PsycheApp.tsx`, rendered by the desktop renderer): S11's shell (rail, threads, panes, browser, keyboard, `view.*`) with the kit's screens through two optional `ShellApp` slots. The slots hold the chat column (messages, blocks, approval dock, question cards, checklist, wrap-up), the agent sheet (Activity, Approvals, Upcoming, Soul & Memory) behind the avatar and at `/agent/*`, and onboarding on first run (`ui.onboarding.completedAt`). `kit-client.ts` adapts the shell's Gateway port to the kit's client. It replays the connection state to late subscribers and fetches this device's answer token for `approval.created` until #50 lands. The persona name and creature come from IDENTITY.md. S11's 7 smoke tests pass on the kit.
- **`receipts.get` / `receipts.list`** over the broker's receipts (the kit loads receipt lines with them after a reload).
- **File tools** stand-in (`read_file`, `write_file`, `list_dir`) until P9 has an owner (#49). The broker checks paths as text, so the tools refuse any path that goes through a symlink (including a dangling final link) and open files with `O_NOFOLLOW`; granted folders must be real paths (on macOS `/private/tmp`, not `/tmp`).
- **Independent review** (subagent, before the PR): 8 findings, all fixed with tests in `tests/integration/compose/file-tools.test.ts`: symlink escapes in reads and writes, Gateway origins without a scheme, a bad stored policy stopping the next boot, phones answering as the desktop surface, an unawaited reissue rebind and token leaks, `questions.list` by task, `$` patterns in onboarding values, task events without a thread id.

## The scenario

Two runs of the same scenario with the scripted model (`scripted-model.ts`: chat, task and utility lanes over `FakeModelProvider`):

- **Protocol level**: `skeleton.test.ts` runs in `pnpm -r test` (CI, macOS and Ubuntu). It drives the desktop's own client over loopback.
- **Electron**: `electron.spec.ts` runs in the macOS `desktop` CI job after the smoke tests. It is Playwright for Electron on the packaged app with the UI kit's screens, against `composeGateway`. Steps: onboarding form, then the composer, then the approval card's "Allow once", then the receipt line, then the question chips and "Answer", then the checklist and wrap-up box, then quitting and relaunching the app with Activity open, then Soul & Memory (daily note, SOUL.md edit, "Export everything"). It passes 3 of 3 runs locally (~8 s).

| Step | Covered |
| --- | --- |
| onboarding names the agent, writes IDENTITY.md / SOUL.md / USER.md | yes (kit `OnboardingFlow` → `writeOnboarding`) |
| first chat turn streams | yes |
| read tool in a granted folder, write proposed | yes |
| approval card outside the chat, Allow once, write with a receipt | yes (kit approval dock, arming, receipt line) |
| structured question with chips, answer resumes the turn | yes |
| pinned checklist updates, wrap-up box offers a next step | yes |
| quitting the window keeps a delegated task running, visible in Activity on relaunch | yes (client disconnects; reconnect lists it done). The delegation shows an extra approval card (#48) |
| memory flush writes today's daily note | yes (forced compaction) |
| Soul & Memory shows and edits the files | yes (kit Soul & Memory tab, Save) |
| "Download your data" exports | yes ("Export everything" → `memory.export` zip; `chat.export`) |

## Live runs (not done yet)

`live.test.ts` runs the protocol-level scenario against a live model and prints `INT-1 timings {…}` (boot, first token, cold start to first token, memory search). **It has not been run.** This Mac has no `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, and no Ollama (`ollama` is not installed). On a machine that has them:

```bash
PSYCHE_LIVE_TESTS=1 PSYCHE_MODEL=anthropic/claude-sonnet-5-5 ANTHROPIC_API_KEY=… pnpm --filter @psyche/integration-tests test -- live
PSYCHE_LIVE_TESTS=1 PSYCHE_MODEL=openai/gpt-6-luna OPENAI_API_KEY=… pnpm --filter @psyche/integration-tests test -- live
brew install ollama && ollama serve &   # then, in another shell:
ollama pull qwen3.8:27b
PSYCHE_LIVE_TESTS=1 PSYCHE_MODEL=ollama/qwen3.8:27b pnpm --filter @psyche/integration-tests test -- live
```

- `PSYCHE_UTILITY_MODEL` (default: the primary model) picks the flush and summary model.
- `PSYCHE_OLLAMA_URL` points at a non-default Ollama.
- The local model must pass S03's `agent-capable` probe (tool calling); see `packages/model-router/README.md`.
- To try the app by hand with a live model: `PSYCHE_MODEL=… pnpm --filter @psyche/gateway start`, then `pnpm --filter @psyche/desktop dev`.

Record the printed timings in the table below.

## Timings

| Measure | Value | Budget (docs/03 cross-cutting) |
| --- | --- | --- |
| `psyched` cold start to `/healthz` (tsx, M-series, no model) | 0.95 s | — |
| Composed Gateway boot in-process | 41 ms | — |
| `chat.send` → first `chat.delta`, scripted model (Gateway + loop overhead) | 7 ms | first token < 3 s with a hosted model (live run pending) |
| `memory.search` | 1 ms | < 100 ms (asserted) |
| Browser snapshot | not on the INT-1 path (INT-2) | < 300 ms |

## Gaps per package

- **apps/gateway (S01)**: answer tokens in `approval.created`, duplicate node receipts, long socket paths (#50); review #45; durable `ThreadStateStore` (#52, with S02).
- **agent-core (S02)**: `task.start` side effect (#48); durable thread state (#52); subagents, evaluator (M2).
- **permissions (S05)**: `task.start` card kind (#48); `audit.*` not in the protocol, so not mounted.
- **P9 file tools (S13 / S02)**: no owner package (#49).
- **desktop / web (S11) and ui (S12)**: the kit's chat, agent sheet and onboarding are mounted (#51). Settings, Feed, Ideas, Goals, Library and Search screens still show S11's placeholders, and the viewers editor slot and pane previews are not wired. S11's own `ChatView` is now unused in the composed app.
- **model-router (S03) / vault (S06)**: `psyched` takes keys from env; vault-backed keys and the model picker are not wired.
- **tasks (S04)**: works as specified; the pool gets the boot reissue result.
- **memory (S07)**: works as specified; flush only runs at compaction (by design).
- **notifications (S15)**: in-app only; the helper relay (S14) is not wired.
- **viewers (S13)**: the kit's `renderEditor` / `renderPreview` slots are not wired yet (plain textarea in Soul & Memory).

## Ownership notes

Outside `compose/**` and `tests/integration/**`, INT-1 changed:

- **S01:** `apps/gateway/src/main.ts` boots through the composition root; `apps/gateway/package.json` gets dependencies and the `./compose` export.
- **S11:**
  - `apps/web/package.json`: the `./compose` and `./compose/onboarding` exports.
  - `apps/web/src/shell/ShellApp.tsx`: optional `slots`; without them the shell behaves as before.
  - `apps/desktop/src/renderer/main.tsx`: renders `PsycheApp` and imports the kit stylesheet.
  - `apps/desktop/vite.renderer.config.ts` and `apps/desktop/package.json`: Tailwind 4.
  - `apps/desktop/e2e/smoke.spec.ts`: two steps use the kit's composer.
- **S00:**
  - `pnpm-workspace.yaml` and the root `vitest.config.ts` add the `tests/integration` package.
  - `.github/workflows/desktop.yml` runs the Electron skeleton and widens its path filter.
  - `README.md` has the "Run the skeleton" section.

The Gateway handler hook landed as #45 (S01).
