# @psyche/vault

## Unreleased (pre-0.3.0)

### Minor Changes

- Web Bot Auth (I14): the browser signs document requests of profile tabs with the vault's Ed25519 key for sites that ask (`Accept-Signature`) or the owner lists; the vault creates and rotates the key (schema v2 allows `signing_key`); the Gateway serves the key directory and `browser.botAuth.status | rotate`; the desktop allows narrow document `Fetch` and merges signature headers into the real request.

## 0.3.0-alpha.0

### Minor Changes

- fa08fee: Restores no longer resurrect deleted vault items: removals go to the revocation ledger (`recordVaultItem`, `vaultItemIds`), and the vault (`VaultOptions.removals`) drops them from its mirror at start and from the encrypted store at every unlock.
- 8a9ee2c: Protocol: `vault.linkExternal`, `vault.payments.list`, `vault.payments.methods`, event `vault.payment.updated`, optional `CredentialMeta.backend`. Vault: the handlers for them (payments through an optional `PaymentBroker`), `PaymentBroker.list / methods / onUpdate`, `backend` on listed items.
- 75ad6fa: `VaultTokenVault`: connector OAuth tokens (G13) stored as connector-owned vault items, surviving restarts, with disconnect emitting the invalidation event.
- 94fe0da: Vault M1: SQLCipher store, key slots, items and refusals, CSV import, placeholder resolution, redaction, fill helpers, OAuth token store and `vault.*` handlers; `credential_meta` / `credential_uses` migration.
- e519e1e: 1Password as a read-only external credential source (G10): `OpCliSource` (service account, `op read`), `OpConnectSource`, and `Vault.linkOnePassword` mapping 1Password items onto `{{cred:slug}}` placeholders.
- 0c82962: Payments: the Link payment method (brand, last4) is shown on and bound into the purchase card; merchant hold, capture, refund, decline and hold release are recorded as checked transitions with receipts and audit entries.
- 396731a: Payments through Stripe Link Agent Wallet (G12): `PaymentBroker` (purchase approval, spend request, 0600 one-time card file, merchant-only card fills, receipts with the Link reference) and the `LinkCliWallet` adapter.

### Patch Changes

- 575ec90: Scenario V4 travel end to end (hold a cheaper fare, ticket it, refund it) through the vault's Stripe Link PaymentBroker in test mode; payment transitions can carry the approval that authorized them.
- f8c95bf: Credentials fill over https only (plain http just for loopback dev servers, #292); a sandbox secret env is leased to one command and wiped after its timeout (#290, vault side).
- Updated dependencies [428ec1e]
- Updated dependencies [a5cef4e]
- Updated dependencies [4f8dff6]
- Updated dependencies [353afa9]
- Updated dependencies [2558bfe]
- Updated dependencies [7ac975c]
- Updated dependencies [09c0c6f]
- Updated dependencies [d982437]
- Updated dependencies [c4175a2]
- Updated dependencies [493b4a5]
- Updated dependencies [eaf91c6]
- Updated dependencies [19c1ba5]
- Updated dependencies [4f74993]
- Updated dependencies [5e605af]
- Updated dependencies [8a8dacb]
- Updated dependencies [6665567]
- Updated dependencies [310ac67]
- Updated dependencies [2f63bac]
- Updated dependencies [dc190a6]
- Updated dependencies [5d2cbeb]
- Updated dependencies [0899f3b]
- Updated dependencies [08664c3]
- Updated dependencies [e54d672]
- Updated dependencies [3461262]
- Updated dependencies [8a9ee2c]
- Updated dependencies [f80b0ec]
- Updated dependencies [75a0f80]
- Updated dependencies [2e9c025]
- Updated dependencies [e4c109b]
- Updated dependencies [5dcf208]
- Updated dependencies [c840e75]
- Updated dependencies [2607fc3]
- Updated dependencies [4bc7113]
- Updated dependencies [515b904]
- Updated dependencies [f4cf9c0]
- Updated dependencies [e0d2f7e]
- Updated dependencies [95f1980]
- Updated dependencies [2b2e906]
- Updated dependencies [13afc8a]
- Updated dependencies [1331bfc]
- Updated dependencies [04be9ec]
- Updated dependencies [2525712]
- Updated dependencies [e7c3564]
- Updated dependencies [a549b95]
- Updated dependencies [75d2aa9]
- Updated dependencies [420ab8e]
- Updated dependencies [206f295]
- Updated dependencies [e99009a]
- Updated dependencies [38f71de]
- Updated dependencies [952c222]
- Updated dependencies [ee4c781]
- Updated dependencies [0c71158]
- Updated dependencies [4b3f571]
  - @psyche/protocol@0.3.0-alpha.0
