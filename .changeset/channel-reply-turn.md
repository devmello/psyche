---
"@psyche/permissions": patch
"@psyche/gateway": patch
---

Channel reply authority: evaluate the replying turn (requesting conversation, mode, deny rules, taint) and verify each iMessage `messages.send` against the approved binding at dispatch, with a receipt.
