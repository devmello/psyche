---
"@psyche/protocol": minor
---

LAN support for the remote Gateway: `ConnectChallenge` gains optional `lanCertSpki` and `lanCertSignature` (the identity key vouching for the self-signed TLS certificate a LAN connection was served with, built by `lanCertSigningPayload`), `gateway.info` gains a `lan` block, and the new method `gateway.lan.rotateCert` replaces the LAN certificate.
