# Session S04 — Tasks and scheduler

You are building Psyche (read `README.md`). You are session **S04 — Tasks and scheduler**: `packages/tasks` (durable background work) and `packages/scheduler` (automations, heartbeat, watches). Work in your own worktree on branch `ws/s04-tasks-scheduler`. You own `packages/tasks/**` and `packages/scheduler/**`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §4.5 (task engine), §4.11 (scheduler and proactivity: automations, heartbeat, watches), §4.3 (unattended-run contract)
3. `docs/03-feature-spec.md` rows D1–D7, O1–O4
4. `docs/04-data-model.md` §3 (tasks, checkpoints, task_actions, input_requests), §8 (automations, automation_runs, watches)
5. `docs/05-security-and-permissions.md` §3 (approval expiry and re-issue), §15 (receipts)
6. Contracts: `TaskEngine`, `Scheduler`, `AgentLoop`, `PermissionBroker`, `Notifier`; fakes in `packages/testing`
7. Research: `opendots_openclaw_harnesses.md` KQ1 §1e–1g (OpenMuse leases, reviews, receipts, uncertain outcomes) and KQ2 §2i (OpenClaw automations, session targets, heartbeat, unattended contract); `claude_desktop_and_peers.md` Q5 (scheduled tasks, catch-up on wake)

## Mission (M1)
- **Task engine**: create tasks from chat delegation or from the loop (`task.start`); plan steps and the harness checklist stored on the task; checkpoints per step with `replay: safe | unsafe`; SQL leases (`lease_owner`, `lease_until`) claimed by worker loops with heartbeat renewal; expired-lease recovery; pause / resume / cancel / retry; `awaiting_input` and `awaiting_approval` parking with resume on answer; `uncertain` outcomes for unsafe steps interrupted mid-flight (never replayed; surfaced for reconciliation); task ownership of browser session and sandbox ids; the Activity log (`task_actions`) with level-1 status line, level-2 structured action, level-3 payload reference.
- **Worker**: in-process worker pool inside the Gateway (single process in M1) running `AgentLoop` turns for tasks with the unattended or attended flag; budgets per task; restart recovery (leases expire, tasks resume from the last checkpoint).
- **Scheduler**: automations (cron via `cron-parser` or equivalent, intervals, one-shots) with timezone, session targets `main | isolated | named`, delivery targets (thread, channel via `Notifier`/channel API, webhook, none), per-job scratch note, pause/run-now/history; the unattended-run contract passed to the loop; **catch-up after sleep** (missed ticks coalesced into one run; one host timer; durable `next_run_at`); heartbeat as a system automation (30–60 min, active hours, light context flag); **watches** (page change / text present / price threshold) implemented against a `fetch` function injected by the connectors package, with dedupe and exponential backoff.
- **Events**: `task.updated`, `task.action`, `automation.run.*` with `stateVersion`; `tasks.*` and `automations.*` API handlers for the Gateway to mount.
- **Upcoming data**: a query that returns everything scheduled (automations, reminders, watches, briefings) with next run times for the Upcoming view (O4).

## Out of scope
The loop itself (S02), policy (S05), UI (S12), Feed/Ideas/Goals pipelines (S15; they call your scheduler API).

## Definition of done
- Tests: two-worker lease race; expired-lease recovery; crash between `unsafe` step start and receipt → `uncertain`; cancellation revoking authority mid-step; pause/resume; input request round trip; approval expiry re-queues the step; cron with DST change; sleep catch-up coalescing 5 missed ticks into 1 run; watch dedupe and backoff; Activity log levels.
- README with the task state machine diagram and the automation session-target semantics; `docs/status/s04.md`.

## Suggested subagents
One to build a time-travel test clock for the scheduler, one to write lease-race property tests, one to review the unattended contract against the OpenClaw notes.

## M2 follow-ons
Evaluator hook before `done` (with S02's C7); heartbeat token accounting; webhook triggers (`POST /hooks/wake` equivalent) through the Gateway; goal check-in automations for S15.
