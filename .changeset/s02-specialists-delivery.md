---
"@psyche/tasks": patch
"@psyche/gateway": minor
---

Background specialists, delivery (#683): one `specialist_result` Inbox card, a `specialist.result` event and a parent-thread line per job; `specialist.spawned` and throttled `specialist.progress` events; the `specialists.list` and `specialists.jobs` handlers; specialist jobs no longer also get a `task_done` / `task_failed` notification.
