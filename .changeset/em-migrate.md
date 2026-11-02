---
"@psyche/gateway": minor
"@psyche/memory": minor
"@psyche/protocol": minor
"@psyche/ui": minor
---

Encrypt memory on disk (EM9b, part 2): Settings → Data controls → "Encrypt memory on disk". On, at the next start the graph, memory index and everything memory move into `state/memory.sqlite` (verified copy, then the plain rows are cleared with secure delete; resumes after a crash). Later migrations reach the encrypted file through a schema sync. Off copies everything back first, then deletes the encrypted file and its key.
