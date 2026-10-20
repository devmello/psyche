---
"@psyche/testing": patch
---

Scenario `Stack` accepts extra fake executors (`StackOverrides.impls`) and services for agent-core's built-in tools (`StackOverrides.services`: tasks, scheduler, notifier, memory), and `startRun` takes a run mode so an automation can start an unattended run. `World.tools` merges extra executors over its own. `tests/scenarios/validate.mjs --dir <path>` validates scenarios in another folder; the schema's receipt kinds gain `message.send`. Used by INT-3's Milestone 2 scenarios; the M1 scenarios are unchanged.
