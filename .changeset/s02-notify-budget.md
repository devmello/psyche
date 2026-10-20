---
"@psyche/agent-core": minor
---

`notify` says "Notify the owner: …" (not "Notified") and a per-Task notify budget (`notifyBudget`, default 3) stops a run that loops on it: past the budget the loop asks once (a deferred card in an unattended run) and blocks further calls while that card waits (#307).
