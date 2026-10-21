---
"@psyche/connectors": minor
"@psyche/gateway": patch
"@psyche/ui": patch
---

Apple connectors are never "connected" without the macOS grant: needs permission with where to allow it, re-checked on status (#549). One-per-machine connectors refuse a second instance (`already_connected`) and duplicates are removed at start.
