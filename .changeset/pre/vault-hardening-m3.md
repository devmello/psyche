---
"@psyche/vault": patch
"@psyche/gateway": patch
---

Credentials fill over https only (plain http just for loopback dev servers, #292); a sandbox secret env is leased to one command and wiped after its timeout (#290, vault side).
