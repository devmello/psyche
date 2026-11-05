---
"@psyche/protocol": minor
"@psyche/skills": patch
"@psyche/gateway": patch
"@psyche/desktop": patch
"@psyche/ui": patch
---

Teach by showing in a Windows app: "Record in an app" works with the Windows helper. An app is its lowercase executable name; the never-recorded list for Windows (`TEACH_NEVER_APPS_WINDOWS`: Psyche, UAC and credential prompts, Windows Security, password managers, wallets, banking) is generated into the helper from the protocol package; the Gateway, the desktop and the draft path accept `.exe` ids; the skill text says "Windows app"; and the recording messages have Windows wording. Design: docs/design/teach-by-showing-2026.md §13.10.
