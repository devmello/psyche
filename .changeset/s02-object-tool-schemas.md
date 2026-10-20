---
"@psyche/agent-core": patch
---

Tool input schemas are always a top-level object (#414): a union of variants (`code.git`'s operations, `memory`'s commands) is advertised as one object with an enum discriminator and still validated per variant. Anthropic refused every request that offered `code.git`.
