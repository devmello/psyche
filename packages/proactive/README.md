# @psyche/proactive

**Owner:** S15 (`prompts/s15-proactive-notifications.md`). Feature ids: O2 (heartbeat budget), O5–O9
in [docs/03-feature-spec.md](../../docs/03-feature-spec.md). Architecture §2 principle 10 and
§4.11; ADR-012; data model §8.

Feed, Ideas and Goals: the proactive surfaces, bounded and confirmable. Everything proactive is
produced by scheduled jobs in batches, cites its evidence, can be dismissed, and never sends or
writes outside Psyche without an approval (an accepted idea becomes a Task that runs under the
Permission Broker).

## Status (M2, in order of the spec's dependencies)

| Slice | Feature ids | State |
| --- | --- | --- |
| Goals, check-ins, confirm-first candidates, `goals.*`, heartbeat budget | O9, O2 | **done** (this package, `apps/gateway/src/compose/proactive.ts`) |
| Interest ledger, Feed pipeline, briefings, `feed.*` | O5, O6 | next PR |
| Ideas pipeline, acceptance model, delivery windows, `ideas.*` | O7, O8 | after the Feed |
| Goal watches, budget audit | O3 | last |

## Public API (`src/index.ts`)

- `PROACTIVITY_BUDGET`: every bound in one place (heartbeat 5k tokens and one notification per
  run; brief 5–10 posts with 1–2 exploration slots; ideas per window and the acceptance
  threshold; open goal candidates and one reminder per check-in). `HEARTBEAT_TASK_BUDGET` is the
  `TaskBudget` the heartbeat launcher gets.
- `GoalsService({ db, clock, scheduler, notifier?, tasks?, newId?, timezone?, onEvent?,
  maxOpenCandidates? })`:
  - `create(input)`: a stated goal, active at once, with milestones and a `cadence` (5-field cron
    or ISO-8601 duration) that becomes a system check-in automation on the scheduler.
  - `propose(candidate)`: an inferred goal as a `candidate` (`inferred: true`, evidence required in
    `plan.evidence`). Returns the open goal with the same title instead of a duplicate, and
    `undefined` when the same goal was rejected before or `maxOpenCandidates` are already open.
  - `decide(goalId, "confirm" | "reject" | "later")`: confirm activates (and only then may a
    cadence, milestones or links be added); reject archives and suppresses the proposal; later
    defers (`plan.deferredUntil`, `plan.deferrals`).
  - `get`, `list`, `progress`, `update` (title, category, status `active | paused | done`, plan,
    cadence), `archive`, `milestone` (add / edit / complete / remove), `link` (exactly one of
    task, automation, watch; `unlink`).
  - `checkinJob()`: the in-process job behind check-in automations. It raises at most one
    `reminder` (dedupe key `goal:<id>:checkin`, route `/goals/<id>`) with milestone and task
    progress and reports `no_reply` to the scheduler, so nothing else is delivered.
  - `start()`: after a restart, re-creates lost check-ins, refreshes `nextCheckinAt`, removes
    check-ins whose goal is gone.
- `createGoalHandlers(goals)`: `goals.list | get | decide | create | update | archive | milestone | link`.
- `withProactiveJobs(inner, { jobs, heartbeat?, onError? })`: wraps the scheduler's `RunLauncher`
  (S07's `withDreaming` pattern). Automations whose prompt is a job marker `[psyche:<job> <arg>]`
  run in-process without an agent turn; `heartbeat` automations go to the bounded launcher; every
  other run reaches `inner`. A job that throws fails its run with a generic summary (the detail
  goes to `onError`), and the scheduler raises its usual `task_failed`.
- `jobMarker`, `parseJobMarker`, `cadenceKind`, `GoalStore`, `normalizeTitle`.

## Gateway wiring

`composeProactive({ db, clock, scheduler, notifier, tasks, publish, timeZone, logger })` in
`apps/gateway/src/compose/proactive.ts`: mounts the handlers, forwards `goal.updated`, wraps the
scheduler's launcher (`proactive.launcher(createTaskLauncher(...), pool)`) and syncs check-ins on
`start()`.

## Invariants (tested in `test/`)

- **Bounded.** Candidates stop at `maxOpenCandidates`; a check-in raises one reminder however
  many ticks it coalesced; the heartbeat task carries `maxTokens: 5000` and an overspending run
  is stopped and reported once.
- **Attributable.** A candidate without evidence is rejected; every reminder carries the goal's
  route; `plan.evidence` and `plan.source` say why a candidate exists.
- **Dismissible.** `decide("reject")`, `archive`, `notifications.resolve`.
- **Confirm-first.** Before `confirm`, a candidate has no automation, task, notification, link
  or milestone, and the agent is never started for it.
- **No sends or writes.** This package calls no channel adapter, connector or model tool. Its
  only outward effects are rows in its own tables, system automations, and inbox notifications.

## How this package maps to the docs

- Tables `feed_posts`, `ideas`, `goals`, `goal_milestones`, `goal_links` (data model §8) in
  `packages/db/migrations/202610201700_proactive_init.sql`, mirrored in `packages/db/src/schema-s15.ts`.
  Additions: `feed_posts.exploration`, `feed_posts.batch_id`, `ideas.pattern_key`,
  `ideas.dismiss_reason`, `goal_milestones.position`, `goal_links.created_at`.
- Check-ins arrive as `reminder` notifications (UI §3.11); the confirm card reads `plan.evidence`.

## What is stubbed

- The Feed and Ideas pipelines and the interest ledger (next PRs).
- Goal plans as artifacts (the PDF plan in UI §3.11) and typed delete confirmation are UI (S12).
- `goal.*` agent tools (architecture §4.3 built-ins) wait for the Ideas PR.
