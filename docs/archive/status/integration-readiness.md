# Integration readiness (2026-10-19)

Written by INT-1 at the start of `int/1-walking-skeleton`, on `main` @ `7457b0c`. The integrator (S00) owns this file from here; update it when the open PRs below land.

## On `main` (merged, CI green on the merge commit unless noted)

| Package / app | Owner | PR | INT-1 uses it for |
| --- | --- | --- | --- |
| `packages/protocol`, `packages/testing`, `packages/db` | S00 / S01 | #1, #29, #30, #43 | frames, contracts, fakes (`FakeModelProvider`), migrations |
| `apps/gateway` | S01 | #31, #43 | server, pairing, threads, chat, session controller, recovery |
| `packages/agent-core` | S02 | #22 | loop, tool registry, built-ins (`ask_user`, `update_plan`, `wrap_up`, files) |
| `packages/model-router` | S03 | #26 | `createModelRouter`, usage ledger, local-model probe |
| `packages/permissions`, `packages/audit` | S05 | #40 | broker, approval cards, grants, receipts, hash-chained audit |
| `packages/memory` | S07 | #37 | workspace + persona files, daily notes, flush, `memory.*` handlers, export |
| `packages/tasks`, `packages/scheduler` | S04 | #24, #36 | task engine + worker pool (background continuation), automations |
| `packages/notifications` | S15 | #19 | inbox, routing |
| `packages/vault` | S06 | #33 | provider keys for live models (not needed with the scripted provider) |
| `packages/sandbox`, `packages/mcp-host`, `packages/channels` | S21 / S09 / S10 | #28, #25, #23 | not on the INT-1 path |
| `packages/viewers` | S13 | #41 | Files / document panes in the desktop |
| `apps/desktop`, `apps/web` | S11 | #42 | Electron shell, shared web shell, Playwright-for-Electron harness |
| `packages/skills`, templates | S20 | #3 | persona templates for onboarding |

The `ci` workflow on `7457b0c` was still running when this was written; `desktop` and `security` passed.

## Open PRs and what INT-1 needs from them

| PR | Owner | State | INT-1 needs | How INT-1 proceeds |
| --- | --- | --- | --- | --- |
| #27 `ws/s12-ui-kit` | S12 | draft, conflicts with `main` | `packages/ui` screens: onboarding, chat blocks, approval and question cards, checklist, Settings → Soul & Memory | merged locally into `int/1-walking-skeleton`; INT-1 rebases onto `main` when #27 lands and never edits `packages/ui` |
| #44 `ws/s13-viewers-m2` | S13 | open | nothing (P2 forms, P8 generators are M2) | not consumed |
| #32 `ws/s08-browser` | S08 | merged | nothing for INT-1 (browser is INT-2) | not consumed |
| #38 / #39 `ws/s09-*` | S09 | #38 merged, #39 open | nothing for INT-1 (connectors are INT-2) | not consumed |
| #20 `ws/s18-injection-runner` | S18 | open | nothing for INT-1 (INT-3 runs it) | not consumed |

## Start conditions per integration prompt

- **INT-1** (`prompts/int-1-walking-skeleton.md`): every listed package is on `main` except `packages/ui` (#27). INT-1 starts now against the local merge of #27, as instructed.
- **INT-2** (`prompts/int-2-browser-connectors-channels.md`): browser (#32), the connector framework (#38) and channels are merged; the Google connector (#39) is still open. INT-2 can start on the INT-1 composition root.
- **INT-3** (`prompts/int-3-acceptance.md`): blocked on INT-1, INT-2 and #20.

## Gaps found before wiring (from `docs/status/*.md`)

These are the "Requests to S01" in the package status files. INT-1 does them in `apps/gateway/src/compose/**` where they are wiring; anything that needs a change inside a package goes to its owner and is listed in [int-1.md](int-1.md).

- `apps/gateway` mounts only `settings.*`, `devices.*`, `threads.*`, `chat.*`, `nodes.*` and `events.subscribe`. `approvals.*`, `grants.*`, `audit.*`, `questions.*`, `memory.*`, `tasks.*`, `automations.*` and `notifications.*` answer `not_implemented` until the composition root mounts the package handlers.
- `psyched` boots with `UnavailableAgentLoop` and `LockedPermissionBroker` (fail closed); no composition root builds the real ones yet.
- The task engine and notifier need event streams forwarded to the bus (S04, S15 requests).

## INT-1 progress

`int/1-walking-skeleton` wires the composition root and passes the scenario with the scripted model; see [int-1.md](int-1.md). The Gateway handler hook (#45) is merged; the screens wait on #27.
