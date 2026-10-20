---
"@psyche/files": minor
"@psyche/protocol": minor
"@psyche/agent-core": patch
"@psyche/gateway": patch
---

P9 file tools get a package (#49): `@psyche/files` ships `read_file`, `write_file`, `edit_file`, `list_dir` and `search_files` with symlink, traversal and granted-folder refusal, size caps and paging, atomic writes, exact-match edits with conflict detection, and write provenance. `ToolCallDescription` gains optional display-only `details`, which the agent loop puts on the approval card (the `file_write` card's diff). The Gateway registers the package in place of INT-1's stand-in.
