---
"@psyche/protocol": minor
"@psyche/agent-core": patch
"@psyche/permissions": patch
"@psyche/channels": patch
---

`task.start` is a `write` with its own `task_start` approval kind (#48, review design-08): agent-core declares it, the broker infers it and titles the card "Start background task", chat cards say "Start a background task".
