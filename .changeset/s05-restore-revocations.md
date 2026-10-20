---
"@psyche/permissions": minor
"@psyche/backup": patch
"@psyche/gateway": patch
"@psyche/audit": patch
---

Restoring a backup no longer brings back revoked devices or grants: revocations go to a ledger outside the backup that the Gateway replays at every boot, and a restore into a home without it un-pairs devices and revokes every standing grant (S23 design-26).
