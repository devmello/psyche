# Skill changelog

Newest first. The `reflect` skill reads the top entry to know where the last pass stopped.

## 2026-11-09: initial setup (up to PR #1300)
- Created `orchestrate`, `psyche-builder` (+ `learnings.md`, seeded from the orchestrator's ops memory), `psyche-i18n`, `psyche-apple` and `reflect`.
- Created the agents `haiku-verifier` and `security-reviewer`. Builders are sessions, not subagents, so the owner can see and steer them. Their compaction tier comes from the presets `psyche-haiku-40` and `psyche-haiku-60`.
- Added the verification loop: `.claude/scripts/verify.sh` plus the Stop hook `stop-verify.sh`.
- Evidence: owner request on 2026-11-09, and the ops rules from 2026-10-19 to 2026-11-09.
