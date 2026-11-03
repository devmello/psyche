---
"@psyche/search": patch
"@psyche/connectors": patch
"@psyche/gateway": patch
"@psyche/protocol": patch
"@psyche/ui": patch
"@psyche/skills": patch
---

Search sources: the Apple sources now read in pages. Notes and Reminders list 500 at a time with a new `offset` (the Mac helper and the Apple connector accept it), Calendar splits a window that fills a page, and Mail walks back in bounded date windows (a week to start) and halves a window Mail cannot answer instead of failing with "Mail search took too long". The "limit must be 1–500" errors on Notes, Calendar and Reminders are gone. Messages reads at most 200 rows a call, as the helper serves, and a refusal from the helper (for example Full Disk Access) now shows the helper's own words instead of a bare "forbidden". New **Memory** source in Settings → Search sources: it indexes your people, projects, work that's due, events and reviewed, non-sensitive facts on this Mac. It is off until you switch it on, off for Psyche's agent until you allow it, leaves out anything sensitive, still waiting for review, written by a third party or kept private, and memory never learns from it.
