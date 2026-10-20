---
"@psyche/gateway": minor
---

psyched composes the S06 vault: `vault.*` methods, vault events as frames, a shared secret redactor on the Gateway's logs, and connector OAuth tokens stored as vault items (`VaultTokenVault`) so connections survive a restart. The key slot is the key file in server mode (`PSYCHE_VAULT_KEY_FILE`), else safeStorage, else the keychain through a connected Mac helper.
