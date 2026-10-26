---
"@psyche/protocol": minor
"@psyche/testing": minor
"@psyche/tasks": minor
"@psyche/agent-core": minor
"@psyche/gateway": minor
---

Background specialists, part 2a (#683): a dedicated specialist pool (`specialists.maxConcurrent`, default 3, at most 2 per parent thread) with queue positions; the chat pool no longer claims specialist jobs; `ClaimOptions` origin and per-parent filters; the spawn pre-flight stored on `SpecialistSpec` and returned on `SpecialistJob`.
