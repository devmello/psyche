---
"@psyche/desktop": minor
---

Auto-update verifies a signed update manifest (Ed25519 release key embedded in the app, pinned release host, no downgrades, per-artifact SHA-256) before Squirrel.Mac sees anything; the release workflow signs it.
