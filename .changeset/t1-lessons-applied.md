---
"@psyche/db": minor
"@psyche/tasks": minor
"@psyche/gateway": minor
---

`lessonsApplied` on agent messages and task runs (teaching loop §5.1, #679): the Gateway reads each run's assembled prompt after it ends, records the live lessons it carried on the run's messages (or its task, accumulated across runs) and moves their `lastAppliedAt`. Additive columns `messages.lessons_applied` and `tasks.lessons_applied`.
