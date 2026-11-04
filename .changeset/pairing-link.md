---
"@psyche/protocol": minor
"@psyche/db": minor
"@psyche/gateway": minor
"@psyche/ui": minor
"@psyche/desktop": minor
"@psyche/web": patch
"@psyche/channels": patch
---

Pairing links (remote Gateway R2): `devices.pairing.createLink` (admin, side-effecting) makes a `psyche-pair:v1:<base64url {gatewayUrl, gatewayIdentityKey, setupToken, hostName}>` link with a random, single-use setup token that is stored hashed and lasts 10 minutes. `connect.verify` takes an optional `setupToken` (sent only after the client verified the Gateway's key, and only with `gatewayKey`), which marks the resulting pending request "expected via pairing link" (`PairingRequest.viaPairingLink`); the owner still approves the device and its scopes, so the token never grants access. An expired, reused, unknown or unbound token is denied. One outstanding link per admin; revoking an admin deletes its unused links. Creation, use and refusal are audited (`pairing_link.created`, `.used`, `.refused`). Settings → Devices gets Add phone or computer with Copy, a QR code and a countdown, and a remote desktop's Add a Gateway accepts a pasted link (address and identity key from the link, token sent on the first connect only, and cleared on any outcome).
