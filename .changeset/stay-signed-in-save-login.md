---
"@psyche/ui": minor
"@psyche/gateway": minor
---

Stay signed in and save to vault: after the owner signs in inside a clean browser tab, the pane asks "Stay signed in to <site>?" (moves that flow's cookies, SSO hosts included, into the persistent profile and adds the origin to the signed-in list the Gateway reads for `auto` mode) and "Save login to Psyche vault?" (origin, username, masked password; "Never for this site"). Settings → Browser lists signed-in sites with "Sign out / forget". Capture happens only in owner control, on top-level https frames.
