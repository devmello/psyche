---
"@psyche/protocol": minor
"@psyche/permissions": patch
"@psyche/channels": patch
"@psyche/testing": patch
---

`ApprovalKind` gains `git_write` and `git_push` (V10 coding helper; a push is offered `once` only), and `SandboxRunner.ensureSandbox` takes optional `mounts` (bind mounts of granted host folders, fixed per scope).
