---
"@psyche/protocol": minor
"@psyche/tasks": minor
"@psyche/sandbox": minor
"@psyche/testing": minor
---

Taint hand-offs from S02's loop-grants work: `Task.taintSources` is persisted in SQLite (design-08, #96), and the sandbox keeps file-level provenance on workspace files and exec results (`ExecRequest.provenance` / `taintSources`, `ExecResult.provenance`; design-07, #97).
