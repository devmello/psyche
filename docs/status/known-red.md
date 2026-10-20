# Known red areas

Failures found by the nightly, on-demand or tag CI runs (or by anyone) that did not block a merge under the local merge gate (prompts/_shared-rules.md, "Merge gate"). Fix them at the next version bump; add the date, the job, the failing test and the suspected owner.

| Date | Where it failed | Test or check | Owner | Notes |
| --- | --- | --- | --- | --- |
| 2026-10-19 | ci (ubuntu-latest), several PRs | packages/viewers react-artifact and SheetEditor real-browser tests (timing) | S13 | Flaky on shared runners; waits raised on main, still intermittent. |
| 2026-10-19 | batched test pass on main 63e9cab | packages/testing scenarios + tests/acceptance offline/scenarios.test.ts: V1 `apr_v1_probe` | agent-core (issues-agent-loop) | Caused by #190 overriding Gateway taint sources; fixed in #203 (queued). |
| 2026-10-19 | batched test pass on main 63e9cab | tests/acceptance offline/scenarios-m2-format.test.ts: validate.mjs | agent-core (issues-agent-loop) | #199 added ApprovalKind task_start without tests/scenarios/schema.json; fixed in #203. |
| 2026-10-19 | batched test pass on main 63e9cab | tests/acceptance offline/scenarios-m2.test.ts: v9-weekly-review hard failure | agent-core (issues-agent-loop) | Likely #199 (task.start is now a write with a task_start card). |
| 2026-10-19 | batched test pass on main 63e9cab | packages/ui test/screens-settings.test.tsx: expects 15 sections, now 16 | S11 desktop | #191 added Settings → Browser. |
