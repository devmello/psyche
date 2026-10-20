---
"@psyche/channels": patch
---

Inbound channel events carry `taintSources` for forwarded, third-party quoted and non-owner content, so the Gateway can taint the turn even when the owner sent the message (#275).
