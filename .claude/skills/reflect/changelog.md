# Skill changelog

Newest first. The `reflect` skill reads the top entry to know where the last pass stopped.

## 2026-11-09: verify runs related tests by default
- `verify.sh`: in each touched package it now runs `vitest related` on the touched files, not only the touched test files (`--no-related` opts out). A failing file gets one re-run as a flake filter, then a run on the merge base. Failures that also happen on the base are reported as pre-existing and don't block.
- Evidence: the independent reviews of #1299 (`apps/gateway/test/host-terminal.test.ts:619` broken by `connection.ts`) and #1300 (`apps/gateway/test/passkeys.test.ts:141` broken by `handlers/settings.ts`). Both builders ran only the tests they wrote. A clean main also had 2 failing gateway tests, so a pre-existing failure would otherwise have blocked every builder.
- Cost: a `connection.ts` change pulls in 149 of 244 gateway test files, about 6 min with one worker. The Stop hook timeout was raised to 30 min.

## 2026-11-09: initial setup (up to PR #1300)
- Created `orchestrate`, `psyche-builder` (+ `learnings.md`, seeded from the orchestrator's ops memory), `psyche-i18n`, `psyche-apple` and `reflect`.
- Created the agents `haiku-verifier` and `security-reviewer`. Builders are sessions, not subagents, so the owner can see and steer them. Their compaction tier comes from the presets `psyche-haiku-40` and `psyche-haiku-60`.
- Added the verification loop: `.claude/scripts/verify.sh` plus the Stop hook `stop-verify.sh`.
- Evidence: owner request on 2026-11-09, and the ops rules from 2026-10-19 to 2026-11-09.
