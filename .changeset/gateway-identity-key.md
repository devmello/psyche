---
"@psyche/protocol": minor
---

Add the Gateway identity key: `ConnectChallenge` gains optional `gatewayKey` and `gatewaySignature`, `gatewaySigningPayload` builds the bytes the Gateway signs, and the new method `gateway.info` returns the key, its fingerprint and whether the Host is set up to be reached from other computers.
