---
"@psyche/gateway": minor
"@psyche/channels": minor
"@psyche/backup": minor
"@psyche/db": minor
"@psyche/cli": minor
"@psyche/desktop": minor
"@psyche/web": minor
"@psyche/ui": minor
---

Third review of the update foundation. The one-Gateway-per-data-folder lock is now the kernel's (`O_EXLOCK` on macOS, an exclusive SQLite lock elsewhere), so a crash, SIGKILL or reboot never leaves it stale, and a second Gateway's refusal is shown on the start-up screen. Held chat messages are replayed in the background and never stop the Gateway from starting; each goes through today's channel, identities, allowlist and rate limit as a live message does, is dropped when its thread is gone, its sender is no longer allowed or it is over a day old, and is excluded from backups and dropped on restore. File hashes are streamed, so databases over 2 GiB snapshot. A crash loop keeps one displaced copy per snapshot, not one per lap; a release that ran in between vetoes a restore; displaced files are kept 30 days, logged at warn level and named by `psyche doctor`. The start-up screen has "I put my data back myself" after a restore that could not be finished.
