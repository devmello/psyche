# @psyche/tasks

## Unreleased (pre-0.3.0)

### Minor Changes

- Background specialists, part 1 (#683): `specialist.spawn`, `specialist.report` and `specialist.status`; specialist runs with their role's prompt, model, tool allowlist and clamped mode; the Specialists prompt section; `tasks.specialist` storage with `updateSpecialist`; the Gateway's specialist host (roles from the role skills and Settings, a subagent thread and task per job, one sanitized result).
- `lessonsApplied` on agent messages and task runs (teaching loop §5.1, #679): the Gateway reads each run's assembled prompt after it ends, records the live lessons it carried on the run's messages (or its task, accumulated across runs) and moves their `lastAppliedAt`. Additive columns `messages.lessons_applied` and `tasks.lessons_applied`.
- Run trace T1, part 3 (#660): task, automation and specialist turns are recorded through the run-trace sink (`TaskWorkerPoolOptions.trace`); automation runs name their agent run and usage; memory writes name their run and step; computer-use screenshots become run frames.
- Background specialists, part 2a (#683): a dedicated specialist pool (`specialists.maxConcurrent`, default 3, at most 2 per parent thread) with queue positions; the chat pool no longer claims specialist jobs; `ClaimOptions` origin and per-parent filters; the spawn pre-flight stored on `SpecialistSpec` and returned on `SpecialistJob`.

### Patch Changes

- Background specialists, delivery (#683): one `specialist_result` Inbox card, a `specialist.result` event and a parent-thread line per job; `specialist.spawned` and throttled `specialist.progress` events; the `specialists.list` and `specialists.jobs` handlers; specialist jobs no longer also get a `task_done` / `task_failed` notification.

## 0.3.0-alpha.0

### Minor Changes

- f2761ef: Tasks: SQLite task engine (leases, checkpoints, uncertain steps, parking, Activity log), in-process worker pool driving AgentLoop turns, and tasks.* handlers; db gains the tasks, task_checkpoints, task_actions and input_requests tables.
- 38f71de: Taint hand-offs from S02's loop-grants work: `Task.taintSources` is persisted in SQLite (design-08, #96), and the sandbox keeps file-level provenance on workspace files and exec results (`ExecRequest.provenance` / `taintSources`, `ExecResult.provenance`; design-07, #97).

### Patch Changes

- cf3c922: Write-ahead dispatch (#63): the loop awaits `StartTurnInput.beforeDispatch` before every dispatch and `TaskWorkerPool` commits the step's `running` checkpoint there, so a crash never re-sends an applied effect. Restart re-issue (#64): a recovered Task turn waits on the card `reissue()` issued for the same call instead of showing the owner a second one. The resumability tests now assert both fixes.
- Updated dependencies [428ec1e]
- Updated dependencies [a5cef4e]
- Updated dependencies [4f8dff6]
- Updated dependencies [353afa9]
- Updated dependencies [2558bfe]
- Updated dependencies [7ac975c]
- Updated dependencies [09c0c6f]
- Updated dependencies [d982437]
- Updated dependencies [c4175a2]
- Updated dependencies [493b4a5]
- Updated dependencies [eaf91c6]
- Updated dependencies [19c1ba5]
- Updated dependencies [4f74993]
- Updated dependencies [5e605af]
- Updated dependencies [8a8dacb]
- Updated dependencies [6665567]
- Updated dependencies [310ac67]
- Updated dependencies [2f63bac]
- Updated dependencies [dc190a6]
- Updated dependencies [5d2cbeb]
- Updated dependencies [0899f3b]
- Updated dependencies [08664c3]
- Updated dependencies [e54d672]
- Updated dependencies [3461262]
- Updated dependencies [8a9ee2c]
- Updated dependencies [f80b0ec]
- Updated dependencies [75a0f80]
- Updated dependencies [2e9c025]
- Updated dependencies [e4c109b]
- Updated dependencies [5dcf208]
- Updated dependencies [c840e75]
- Updated dependencies [2607fc3]
- Updated dependencies [8d1c739]
- Updated dependencies [f2761ef]
- Updated dependencies [9a0cd76]
- Updated dependencies [4bc7113]
- Updated dependencies [1cc7f5a]
- Updated dependencies [515b904]
- Updated dependencies [e3014c1]
- Updated dependencies [4876a72]
- Updated dependencies [f4cf9c0]
- Updated dependencies [e0d2f7e]
- Updated dependencies [95f1980]
- Updated dependencies [76bc9cc]
- Updated dependencies [2b2e906]
- Updated dependencies [13afc8a]
- Updated dependencies [1331bfc]
- Updated dependencies [04be9ec]
- Updated dependencies [2525712]
- Updated dependencies [0ee0215]
- Updated dependencies [031c829]
- Updated dependencies [ed58763]
- Updated dependencies [e7c3564]
- Updated dependencies [a549b95]
- Updated dependencies [06ae560]
- Updated dependencies [75d2aa9]
- Updated dependencies [420ab8e]
- Updated dependencies [206f295]
- Updated dependencies [e99009a]
- Updated dependencies [38f71de]
- Updated dependencies [952c222]
- Updated dependencies [ee4c781]
- Updated dependencies [0c71158]
- Updated dependencies [94fe0da]
- Updated dependencies [4b3f571]
  - @psyche/protocol@0.3.0-alpha.0
  - @psyche/db@0.3.0-alpha.0
