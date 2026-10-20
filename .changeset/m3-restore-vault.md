---
"@psyche/permissions": minor
"@psyche/vault": minor
"@psyche/gateway": patch
---

Restores no longer resurrect deleted vault items: removals go to the revocation ledger (`recordVaultItem`, `vaultItemIds`), and the vault (`VaultOptions.removals`) drops them from its mirror at start and from the encrypted store at every unlock.
