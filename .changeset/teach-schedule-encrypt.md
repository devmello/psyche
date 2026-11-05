---
"@psyche/protocol": minor
"@psyche/db": minor
"@psyche/scheduler": minor
"@psyche/skills": minor
"@psyche/gateway": minor
"@psyche/browser": minor
"@psyche/desktop": minor
"@psyche/web": minor
"@psyche/ui": minor
---

Teach by showing: run a recorded skill every week, and keep recordings encrypted.

"Run it every week" is on the page of a skill made from a recording (Settings, Skills). The owner picks the day and time; it appears in Scheduled with its history, a pause switch and remove. Only the Psyche app on this Mac can schedule it; the agent cannot. A skill with a sensitive step, or a value asked for each time, is refused with the step numbers. Every run uses the normal approvals and waits for the owner when one is needed. Any `browser.check_target` miss ends the run at once ("the page changed at step 3") and notifies the owner; a scheduled run acts only on an element a check just found.

Kept recordings are now AES-256-GCM encrypted with a per-install key held in the OS keychain (Electron `safeStorage`). Older signed plain files are migrated on first use; wrong-key and tampered files are ignored and logged. Without a keychain no recording is kept, and Settings, Browser says so. The signing key is now also wrapped by the keychain (an older unwrapped key is wrapped in place).

New methods `skills.recording.unattended` and `skills.recording.schedule`; `Automation` and `ScheduledItem` gain `recordedSkill`; new column `automations.recorded_skill`.
