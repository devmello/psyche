---
"@psyche/permissions": patch
"@psyche/channels": patch
"@psyche/ui": patch
---

Approval, question and wrap-up cards render per surface through one function (`@psyche/permissions/cards`, review design-12): chat transports send `renderForSurface(surface, approval)` and show a device-only approval as "Answer this on your Mac." with nothing answerable; the UI kit's cards consume the desktop rendering from the same function, so the surfaces cannot drift.
