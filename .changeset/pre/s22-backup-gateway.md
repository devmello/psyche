---
"@psyche/backup": minor
"@psyche/gateway": minor
"@psyche/cli": minor
---

Backups without downtime: `@psyche/backup` holds the archive format shared by `psyche backup` and the Gateway, which now serves `backup.list`, `backup.create` (SQLite online backup), `backup.verify`, `backup.delete` and a redacted `logs.tail`. `psyche backup create` uses the running Gateway.
