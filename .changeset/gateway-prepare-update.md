---
"@psyche/protocol": minor
"@psyche/gateway": minor
"@psyche/tasks": minor
"@psyche/ui": minor
---

New Gateway method `gateway.prepareUpdate` for the update flow. It is callable only by the desktop shell on the Host (the same gate as pairing links). It stops the Gateway taking new chat turns and tasks, waits for running work, flushes the database and answers `ready`, together with a report of what is busy (running tasks, active chats, pending approvals, recordings). If no update follows within the timeout (default 2 minutes), service resumes by itself. While it is closed, a message that would start a turn is refused with `unavailable` and the reason `updating`, which the UI shows in plain words (English for now; the other languages fall back to English). `TaskWorkerPool` gains `canClaim`.
