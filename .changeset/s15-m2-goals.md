---
"@psyche/proactive": minor
"@psyche/db": minor
"@psyche/gateway": minor
---

Goals (O9) and the heartbeat budget (O2): the proactive tables' migration with its drizzle mirror; `GoalsService` with confirm-first inferred candidates, milestones, links and check-ins as system automations on the scheduler (one `reminder` per check-in, run in-process through `withProactiveJobs`); `goals.*` handlers and `goal.updated` events; `PROACTIVITY_BUDGET`, and a heartbeat launcher whose tasks carry a 5k-token budget. psyched wires it in `compose/proactive.ts`.
