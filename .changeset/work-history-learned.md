---
"@psyche/protocol": minor
"@psyche/memory": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

A History section on a work item's page in Memory: recent changes to status, progress, where you stopped, next step and due date, each with when, where it came from (chat, mail, you, nightly) and a source chip. A direct update from chat that is still inside the undo window has an Undo button (the same `memory.work.undoUpdate` rules); other lines keep Review and mark-wrong. Remote connections see the chip's source but not an owner-only source's label. New method `memory.work.history`.

Fix: "Learned: ..." lines in system messages were never rendered; they now show as the quiet line with Undo.
