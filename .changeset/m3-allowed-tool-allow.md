---
"@psyche/permissions": patch
"@psyche/testing": patch
---

An allowlisted sender's calls outside the route's `toolAllow` are refused (`requester:not_owner`), so chat-only routes (`toolAllow: []`, #321) get no tools at all (#293).
