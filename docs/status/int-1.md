# INT-1 status: walking skeleton (2026-10-19)

Branch `int/1-walking-skeleton`. Plan: [docs/plans/int-1.md](../plans/int-1.md). Readiness: [integration-readiness.md](integration-readiness.md).

## What works

- **Composition root** `apps/gateway/src/compose/`: `composeGateway()` builds the real agent loop (`agent-core`), model router or an injected provider, Permission Broker with the SQLite store, hash-chained audit log, memory store with flush, task engine and worker pool, scheduler and notifier, and starts the Gateway with them. `psyched` (`apps/gateway/src/main.ts`) boots through it, with the model from `PSYCHE_MODEL` (keys from the provider's env variable; vault-backed keys come with S03/S06). Without a model it starts and answers turns with "No model is configured yet".
- **Mounted handlers**: `approvals.*`, `grants.*`, `questions.*`, `memory.*`, `tasks.*`, `automations.*`, `notifications.*` (through `startGateway({ handlers })`, PR #45 to S01).
- **Events forwarded to the bus**: `approval.updated`, `receipt.created`, `memory.*`, `task.*`, `automation.*`, `notification.*`.
- **Answer tokens** reach the right surface through `approvals.get` / `approvals.list` (`compose/approval-tokens.ts`; see #50).
- **Folder grants**: `permissions.policy` is applied to the broker at boot and on every `settings.changed`.
- **Onboarding writes** `@psyche/web/compose` `writeOnboarding()`: IDENTITY.md (name, creature, tagline), USER.md (name, timezone), SOUL.md when a preset is chosen.
- **File tools** stand-in (`read_file`, `write_file`, `list_dir`) until P9 has an owner (#49).

## The scenario

`tests/integration/walking-skeleton/skeleton.test.ts` runs in `pnpm -r test` (CI, macOS and Ubuntu) with the scripted model (`scripted-model.ts`: chat, task and utility lanes over `FakeModelProvider`), driven by the desktop's own client over loopback:

| Step | Covered |
| --- | --- |
| onboarding names the agent, writes IDENTITY.md / SOUL.md / USER.md | yes (over `memory.*`; the onboarding screen itself is not mounted, #51) |
| first chat turn streams | yes |
| read tool in a granted folder, write proposed | yes |
| approval card outside the chat, Allow once, write with a receipt | yes (over `approvals.get` / `approvals.answer`; card UI #51) |
| structured question with chips, answer resumes the turn | yes |
| pinned checklist updates, wrap-up box offers a next step | yes |
| quitting the window keeps a delegated task running, visible in Activity on relaunch | yes (client disconnects; reconnect lists it done). The delegation shows an extra approval card (#48) |
| memory flush writes today's daily note | yes (forced compaction) |
| Soul & Memory shows and edits the files | yes (over `memory.read` / `memory.write`) |
| "Download your data" exports | yes (`memory.export` zip, `chat.export`) |

`live.test.ts` runs the same path against a live model with `PSYCHE_LIVE_TESTS=1 PSYCHE_MODEL=…` and prints timings. **It has not been run yet**: this machine has no Anthropic or OpenAI key and no local model server. The owner's manual runs (Anthropic, OpenAI, one `agent-capable` local model) are still open.

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
- **desktop / web (S11) and ui (S12)**: screens not mounted, Electron e2e not written (#51). INT-1 consumes `packages/ui` from `ws/s12-ui-kit` (#27, draft) and rebases when it lands.
- **model-router (S03) / vault (S06)**: `psyched` takes keys from env; vault-backed keys and the model picker are not wired.
- **tasks (S04)**: works as specified; the pool gets the boot reissue result.
- **memory (S07)**: works as specified; flush only runs at compaction (by design).
- **notifications (S15)**: in-app only; the helper relay (S14) is not wired.
- **viewers (S13)**: not on the protocol-level path; mounts with the screens (#51).

## Ownership notes

Outside `compose/**` and `tests/integration/**`, INT-1 changed: `apps/gateway/src/main.ts` (boots through the composition root), `apps/gateway/package.json` (dependencies, `./compose` export), `apps/web/package.json` (`./compose` export), `pnpm-workspace.yaml` and the root `vitest.config.ts` (the `tests/integration` package), `README.md` ("Run the skeleton"). The Gateway handler hook is PR #45 to S01, merged into this branch locally.
