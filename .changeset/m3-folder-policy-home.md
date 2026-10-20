---
"@psyche/permissions": patch
---

File tools never reach Psyche's own files (only `workspace/` and `library/` under `$PSYCHE_HOME`), SSH keys, CLI credentials or browser profiles, and never change protected memory files or workspace skills, whatever folder is granted (#285).
