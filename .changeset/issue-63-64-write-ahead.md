---
"@psyche/agent-core": patch
"@psyche/tasks": patch
"@psyche/testing": patch
---

Write-ahead dispatch (#63): the loop awaits `StartTurnInput.beforeDispatch` before every dispatch and `TaskWorkerPool` commits the step's `running` checkpoint there, so a crash never re-sends an applied effect. Restart re-issue (#64): a recovered Task turn waits on the card `reissue()` issued for the same call instead of showing the owner a second one. The resumability tests now assert both fixes.
