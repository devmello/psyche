---
"@psyche/files": minor
---

`read_file` extracts text from PDF, DOCX and XLSX (extension plus magic bytes) in a worker thread with a heap cap and a deadline, headed by page or sheet references and paged with `offset` / `nextOffset` or `page`. Results are `untrusted`. This closes P9's "done when": a 20 MB PDF reads as bounded text with page references.
