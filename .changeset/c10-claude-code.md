---
"@psyche/agent-core": minor
"@psyche/harnesses": minor
"@psyche/gateway": minor
---

C10: a Claude Code harness behind `harness.delegate`. The `claude` CLI runs headless in its own sandbox (repo mounted, network only to the Anthropic API, key from the vault per session) and every tool call it makes asks Psyche first through a `PreToolUse` hook relay; edits ask as `file_write`, commands as `exec`, pushes as `git_push`. Harness actions can now name their approval kind. Registered only with the `harness.claudeCode` setting; Codex and pi are stubs.
