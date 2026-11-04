---
"@psyche/protocol": minor
"@psyche/memory": minor
"@psyche/db": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

Work updates from chat now show a quiet note under the turn. A status or deadline proposal says "Psyche noticed: Thesis draft, due Friday" with Confirm and Discard right there (the same `memory.review.decide` Review uses, so ignoring the note leaves it in Review). A progress, stopped-at or next-step line written from chat says what changed with Undo, which restores the previous value only if the field has not changed since. New `work_note` block and `memory.work.undoUpdate` method.
