---
"@psyche/protocol": minor
"@psyche/browser": minor
"@psyche/skills": minor
"@psyche/desktop": minor
"@psyche/web": minor
"@psyche/ui": minor
---

Teach by showing, browser phase (J8). Press Record on a tab of the built-in browser, do a task once, press Stop, review the steps in plain words (edit, reorder, delete, mark values as inputs), and Save: the skill draft goes through the usual approval card, and "Run it once now" fills the message box so the agent runs it with the normal browser tools (every action through the permission broker). Owner-initiated only: no tool, method or bridge command starts or reads a recording. Passwords, card numbers, one-time codes and ID numbers are never recorded; other typed values are hidden unless kept; cookies and storage are never read; page text is quoted as untrusted data in the skill. New `browser.check_target` tool (replay stops and asks when the page changed), `skills.drafts.fromRecording` method and `BrowserTeachStep` types. Design: docs/design/teach-by-showing-2026.md.
