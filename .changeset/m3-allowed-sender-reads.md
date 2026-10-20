---
"@psyche/permissions": patch
"@psyche/testing": patch
---

An allowlisted (non-owner, non-designated) sender's turn gets no reads of the owner's sources (`requester:not_owner`); only `web_search` / `web_fetch` and no-effect calls remain (#293). The fake broker matches.
