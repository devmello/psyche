---
"@psyche/channels": patch
"@psyche/gateway": patch
---

SMS webhook refusals are empty 403s counted and audited per claimed sender against the inbound limit; docs/05 §9 documents webhook channels (the provider signature replaces the transport gate).
