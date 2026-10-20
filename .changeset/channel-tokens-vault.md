---
"@psyche/gateway": patch
---

Discord and SMS read their tokens from the Gateway-owned vault items (`channels.secrets.set`) when the environment has none.
