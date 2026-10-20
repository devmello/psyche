---
"@psyche/browser": patch
"@psyche/gateway": patch
---

Browser recording and replay (I10): recordings hold an event log (tabs, navigations, snapshots, actions, fills, downloads, blocks, control, dialogs) beside the screencast frames, redacted at write time; `RecordingStore` and the Gateway's `browser.recordings.*` methods serve them to the Activity sheet, with 7-day retention and Library import.
