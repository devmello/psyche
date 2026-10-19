# @psyche/scheduler

**Owner:** S04 (`prompts/s04-tasks-scheduler.md`). Feature ids: O1, O4 (O2, O3), D6 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

This package holds automations, the heartbeat and watches, and catches up after the machine sleeps. Every job has a durable `next_run_at` in SQLite, and one host timer is armed for the earliest due job. When the timer fires, or when the laptop wakes and calls `wake()`, every automation that is due runs once, however many ticks it missed.

## Public API (`src/index.ts`)

- `SqliteScheduler` (`implements Scheduler`):
  - Constructor: `new SqliteScheduler({ db, clock, timers?, newId?, nextStateVersion?, launcher?, sessions?, deliverer?, notifier?, watchFetch?, openInputRequests?, defaultTimezone?, maxTimerMs?, maxBackoffMs? })`.
  - Contract methods: `create`, `get`, `list({ kind? })`, `update`, `remove`, `nextRuns`, `tick`, `runNow`.
  - Extensions:
    - `trigger(id)`: a manual run; it resolves with `{ run, taskId }`.
    - `runs(id, { cursor?, limit? })`: run history.
    - `upcoming({ horizonMs?, limit? })`: the Upcoming view.
    - `ensureHeartbeat({ everyMinutes, activeHours, timezone })`.
    - `setScratch(id, text)`.
    - `start()`, `stop()`, `wake()`.
    - `idle()`: waits for in-flight runs.
    - `subscribe(listener)`: `automation.updated`, `automation.run.started` and `automation.run.finished`, each with `stateVersion`.
- `parseSchedule(kind, schedule, timezone)` and `parseIsoDuration(text)`.
- `createTaskLauncher({ engine, pool?, budget? })` runs each automation as an unattended Task (`createdFrom: automation`) on `@psyche/tasks`.
- `createDbSessionResolver(db)` resolves session targets to threads.
- `createDeliverer({ notifier?, postToThread?, sendToChannel?, broker?, webhookFetch? })`.
- `buildUnattendedPrompt(automation, run)` and `NO_REPLY`.
- `createAutomationHandlers(scheduler)` provides `automations.list | create | update | delete | run | runs | upcoming`. The extra methods come from devmello/psyche#21.

## Schedules

| Kind | `schedule` | Notes |
| --- | --- | --- |
| `cron`, `briefing`, `heartbeat` | A 5-field cron expression evaluated in `timezone`, or an ISO-8601 duration | Uses cron-parser 5. Across DST: a wall time that does not exist fires once at the next valid time; a wall time that occurs twice fires once. |
| `interval` | An ISO-8601 duration (`PT30M`, `P1D`; at least one minute) | Anchored on the previous fire time, so the phase holds after sleep. |
| `watch` | An ISO-8601 duration | Takes a `watch` config (see below). |
| `reminder` | An ISO-8601 instant with an offset | A one-shot. `nextRunAt` becomes `null` after it fires. |

**Catch-up:** `tick(now)` folds each due automation's fire times up to `now`. Intervals fold arithmetically; cron uses one iterator, capped at 10,000 ticks. Every missed tick folds into one run: `coalesced = n`, `scheduledFor` is the latest missed time, and the prompt says the run covers n missed runs. `next_run_at` moves to the first fire time after `now`. If the previous run of the same automation is still going, the new one is recorded as `skipped`, and a manual run is refused with `conflict`. Re-sending unchanged schedule fields does not reschedule. A reminder whose time has passed is rejected. Deleting an automation cancels its running task. A failing tick re-arms the timer 30 s later.

## Session targets

- `main`: the run happens in the owner's main thread. The heartbeat uses this target.
- `isolated` (the default): each run gets a fresh thread of kind `automation` with session key `cron:<automationId>:<runId>`. This keeps each run's context small and separate from the others.
- `named:<id>`: one persistent thread (session key `named:<id>`) is reused by every run that names it. Use it for jobs that build on their own history.

Every run is `mode: "unattended"`. The prompt starts with the unattended-run contract (architecture §4.3; OpenClaw cron payloads):

- The final message is the deliverable.
- `NO_REPLY` means nothing to report.
- Approvals are deferred into the queue.
- A finished run is not proof of success.

The job's scratch note follows the contract.

## Delivery

- **`NO_REPLY`:** nothing is delivered.
- **Failed runs:** the owner gets one `task_failed` notification.
- **Done runs** go to their delivery target:
  - `none`: nothing.
  - `thread`: that thread, if it is not the run's own thread (the run's own thread already has the result).
  - `channel`: the injected `sendToChannel` (S10). Without it, the result becomes an inbox briefing.
  - `webhook`: needs a public https URL with no credentials; loopback, private, link-local and `.local` / `.internal` hosts are refused. Sending agent output to a third party is `destructive`, and the output of an unattended run may carry untrusted content, so the deliverer asks `PermissionBroker.decide` with tool `automation.webhook`, `destructive`, target origin, `taint: true`, `unattended: true`:
    - `allow` (a standing grant): POST with `redirect: "error"`, then a `webhook.post` receipt.
    - `ask`: a bound approval goes to the queue; the POST happens if the owner approves, after `verifyBinding`.
    - `deny`: a `system` notification.

    `webhookFetch` must apply the connectors' SSRF policy to resolved addresses.
- **No target:** the result still reaches the inbox: `reminder` notifications for reminders, `briefing` for briefings, `task_done` otherwise.
- **The heartbeat** raises at most one `proactive` notification per run.

## Watches

`watch: { url, check, selector?, text?, threshold? }`. The page comes from the injected `watchFetch`; the connectors package's `fetch` supplies the SSRF policy and the size caps. A fetch that takes longer than `watchTimeoutMs` (30 s) is aborted and counts as a failure.

`selector` is a literal marker (1–200 characters), and the check looks at the 2,000 characters after its first occurrence. It is not a regular expression: page text is untrusted, and a pathological regex could block the Gateway's event loop. If the marker is missing (for example, a consent or error page), the check records no observation.

Checks:
- `change`: the first check records a baseline. Each later check alerts when the content differs from the previous observation.
- `text_present`: alerts when the text appears. It does not alert again while the text stays, and it re-arms once the text is gone.
- `price_below` / `price_above`: alert once when the price crosses the threshold, and re-arm after it crosses back.

On failure, the next check waits `interval × 2^failures`, capped at 24 h. A success resets the counter. Watches never start the agent.

## Heartbeat

`ensureHeartbeat({ everyMinutes: 30 | 60, activeHours: { start, end }, timezone })` keeps one system automation, `kind: heartbeat`. Its cron is built from the active hours; for example, `0,30 8-21 * * *` covers 08:00–22:00. It runs in the `main` session with `lightContext: true` and uses a `NO_REPLY` default prompt.

## How it maps to the docs

- Data model §8 is in `packages/db/migrations/202610191300_scheduler_init.sql`. Columns added beyond the data model:
  - `automations.light_context`
  - `automations.system`
  - `automation_runs.task_id`, `trigger`, `scheduled_for`, `coalesced`, `created_at`
  - `watches.alerted_value`, `created_at`, `updated_at`
- `automation_runs.task_id` and `notification_id` are plain TEXT, because launchers and notifications belong to other packages.
- D6 (sleep/wake): `wake()` coalesces missed runs. The worker pool's lease expiry and the tasks engine's `recoverExpired` handle tasks that were interrupted. On `start()`, runs left `running` by a restart are re-followed through `RunLauncher.reattach`; if a run cannot be re-followed, it is closed as `cancelled`.

## What is stubbed

- Webhook triggers (`POST /hooks/wake` style), goal check-in automations for S15, and heartbeat token accounting are M2.
- `wake()` must be called by the desktop shell or the mac helper on system resume. The host timer also re-checks at least every 5 minutes, so clock jumps are noticed even without it.
