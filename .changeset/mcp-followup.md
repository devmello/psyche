---
"@psyche/gateway": patch
"@psyche/ui": patch
"@psyche/mcp-host": patch
---

Removing a tool server unbinds each of its vault items on its own; if the vault is locked the unbind is recorded, retried when the vault unlocks, and an Add under the same id is refused until it is done. The probe's secret card is marked as a check by an explicit flag, not by parsing the server id. Secret redaction of command arguments no longer hides `--auth-mode oauth`, and covers `NAME=value` arguments. The unused `keepBundleProtections` is gone.
