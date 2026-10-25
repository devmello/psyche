---
"@psyche/connectors": patch
"@psyche/ui": patch
---

Apple connectors ask macOS for the grant when it has not decided (Check again asks again), send the owner to System Settings only after a denial, and show the helper's reason when no prompt appeared (#570).
