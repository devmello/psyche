---
"@psyche/vault": minor
"@psyche/gateway": minor
"@psyche/protocol": minor
---

Encrypted memory: the memory key is sealed under the vault's own key (`Vault.escrow`) before the switch turns on, so a new Mac opens it after the vault is unlocked with the recovery key; backups include the encrypted file (still encrypted) and the sealed key; the pre-move safety copy stays until an encrypted backup exists after a later start; turning off also deletes the Keychain item. `DerivedKeyStore.get`/`put`, `writeSubsystemKey`. `MemoryStoreStatus.safetyCopy`.
