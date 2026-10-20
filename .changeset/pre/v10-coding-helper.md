---
"@psyche/agent-core": minor
"@psyche/permissions": patch
"@psyche/gateway": minor
"@psyche/testing": patch
---

V10 coding helper: `code.open`, `code.search`, `code.read`, `code.edit` (unified diffs), `code.run` (sandbox with the repository bind-mounted, `.git` read-only) and `code.git` (host git without hooks; pushes behind a `git_push` card, once only). The Gateway composes the tools after the sandbox part; the scenario Stack takes real tool registrations.
