---
"@psyche/browser": minor
"@psyche/vault": minor
"@psyche/gateway": minor
"@psyche/desktop": patch
---

Web Bot Auth (I14): the browser signs document requests of profile tabs with the vault's Ed25519 key for sites that ask (`Accept-Signature`) or the owner lists; the vault creates and rotates the key (schema v2 allows `signing_key`); the Gateway serves the key directory and `browser.botAuth.status | rotate`; the desktop allows narrow document `Fetch` and merges signature headers into the real request.
