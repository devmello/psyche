---
"@psyche/protocol": minor
"@psyche/permissions": patch
"@psyche/gateway": patch
"@psyche/ui": patch
---

Approvals on the Mac use the system's own owner sheet (Touch ID, or the Mac password through "Use Password…") shown by Psyche Helper, and the helper signs the Gateway's challenge with its device key: no presence key to register, no keychain item, no keychain prompt. The Secure Enclave and login-keychain key (`enclave_keychain_acl`, `enclave_file`), its REPLACE card, `--reset-presence-key` and the development-key switch are gone. The presence challenge is now the bare 64-hex digest (the `sha256:` prefix made every check fail). A cancelled sheet is a quiet "not approved": nothing is audited as rejected or counted, and the card stays as it was. A read-only host command that only the owner's switch or manual mode makes ask needs no presence. `PresenceKeyInfo.kind` gains `device_identity`, `PresenceKeyAlgorithm` gains `ed25519`.
