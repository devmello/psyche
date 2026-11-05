---
"@psyche/protocol": minor
"@psyche/skills": minor
"@psyche/permissions": patch
"@psyche/gateway": minor
"@psyche/desktop": minor
"@psyche/web": minor
"@psyche/ui": minor
---

Teach by showing, phase 2 (J8): "Record in an app". The owner picks one Mac app they already allowed for computer use, does a task once and stops; the Mac helper watches that app's accessibility events (focus, value changes, presses, menu choices) and returns semantic steps ("In Mail, click ‘New Message’", "Type into ‘Subject’", "Choose File > Export") with the app's bundle id, the role and title path, and a fallback. Same review screen and the same `skills.drafts.fromRecording` path as the browser, with a tainted draft, `author: recording` from the draft record and a card that names the app. Privacy: secure fields and fields with password, card, one-time-code, ID-number or secret semantics are decided before any value is read and never recorded; typed values stay hidden unless kept; no screenshots; apps that are not granted, Psyche, system security prompts and password managers are never recorded; a menu-bar indicator with Stop shows while it records. Owner-only: `teach.app.*` needs the desktop shell and `operator.admin`, the helper's `teach.record.*` is unreachable through `nodes.invoke` and agent tools, and the generic IPC relay refuses it. Replay uses the computer-use tools through the permission broker and the app tiers, with a new read-only `computer.check_target` that stops and asks when the recorded element is missing or ambiguous. Design: docs/design/teach-by-showing-2026.md §13.
