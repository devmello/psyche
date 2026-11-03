---
"@psyche/protocol": patch
"@psyche/db": patch
"@psyche/gateway": patch
"@psyche/search": patch
"@psyche/ui": minor
"@psyche/web": patch
"@psyche/skills": patch
---

The main chat can be cleared: **Clear chat…** in its ⋯ menu, ⌘K **Clear the main chat** and `/clear` open a confirm dialog (messages are removed and the agent starts fresh; receipts and the activity log are kept; an unticked box also stages forgetting what was learned from the chat). New `threads.clear` method and `thread.cleared` event.
