---
"@psyche/gateway": minor
"@psyche/backup": minor
"@psyche/db": minor
"@psyche/cli": minor
"@psyche/desktop": minor
---

Fourth review of the update foundation. "I put my data back myself" (the start-up screen and `psyche migrate --retry --restored-by-hand`) is refused unless the unfinished restore is really there and every file it was putting back exists, asks in a native dialog (translated into all 10 languages), and the CLI refuses while a Gateway holds the data folder. The Gateway refuses to create a new empty database where the folder shows earlier data. A restore stages its copies before moving anything, so a full disk never leaves the folder without a database; a displaced folder is named after its snapshot and never deletes different live data (a second copy is kept as `.latest`, replaced each time); a retry after a disk-full failure reuses the snapshot while the data is unchanged and keeps no copy of the failed migration's debris. The lock falls back to SQLite on volumes that cannot take `O_EXLOCK`, does not overwrite another note, and clears its own. Replayed channel messages take their thread from today's route, must match the channel row they name, recompute their taint, and are never dropped by a concurrent hold. `last-boot.json` is excluded from backups and dropped on restore.
