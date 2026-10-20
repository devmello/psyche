---
"@psyche/web": minor
"@psyche/ui": minor
"@psyche/gateway": patch
---

The web client's Settings → Devices & nodes lists, adds and removes this browser's passkeys, and approval cards that require authentication (purchases, credential fills, host commands, security settings) are approved with a passkey assertion over the card's presence challenge. The kit's `GatewayClient` gains an optional `presence` hook for that. Fixes the Gateway's WebAuthn challenge for `sha256:`-prefixed presence challenges, which made every real browser assertion fail.
