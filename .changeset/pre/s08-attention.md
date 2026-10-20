---
"@psyche/browser": patch
"@psyche/gateway": patch
"@psyche/desktop": patch
---

Pause-when-unwatched for the browser (#272): actions on sensitive-category origins need the pane visible and recent owner input, else `presence_required/awaiting_attention`; the desktop reports pane visibility and owner input to the Gateway.
