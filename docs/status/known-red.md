# Known red areas

Failures found by the nightly, on-demand or tag CI runs (or by anyone) that did not block a merge under the local merge gate (prompts/_shared-rules.md, "Merge gate"). Fix them at the next version bump; add the date, the job, the failing test and the suspected owner.

| Date | Where it failed | Test or check | Owner | Notes |
| --- | --- | --- | --- | --- |
| 2026-10-19 | ci (ubuntu-latest), several PRs | packages/viewers react-artifact and SheetEditor real-browser tests (timing) | S13 | Flaky on shared runners; waits raised on main, still intermittent. |
