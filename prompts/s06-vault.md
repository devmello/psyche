# Session S06 — Credential Broker (vault)

You are building Psyche (read `README.md`). You are session **S06 — Vault**: `packages/vault`, the credentials manager that keeps secrets out of the model. Work in your own worktree on branch `ws/s06-vault`. You own `packages/vault/**`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §2 (principle 5), §4.7
3. `docs/05-security-and-permissions.md` §4 (Credential Broker specification) and §14 (data handling)
4. `docs/03-feature-spec.md` rows G1–G14
5. `docs/04-data-model.md` §6 (vault schema, metadata mirror, placeholder grammar)
6. `docs/07-tech-decisions.md` ADR-006
7. Contracts: `CredentialBroker`, `PermissionBroker`, `NodeClient` (for the mac helper's keychain capability); fakes in `packages/testing`
8. Research: `agent_browser_and_credentials.md` KQ4 (1Password/Bitwarden patterns, placeholder substitution, local vault building blocks), `macos_vm_and_integration.md` KQ7 (data-protection keychain, Touch ID access control, safeStorage internals)

## Mission (M1)
- **Vault storage**: SQLCipher database (`@journeyapps/sqlcipher` or `better-sqlite3-multiple-ciphers`; verify maintenance and licensing) at `$PSYCHE_HOME/vault/vault.db`; random 32-byte key; key wrapping through a `KeyWrapper` interface with two implementations: `KeychainWrapper` (calls the mac helper's `keychain.*` capability, which stores the wrapped key in the data-protection keychain with the access control `[.biometryCurrentSet, .or, .devicePasscode]`, never a bare `userPresence | biometryCurrentSet` combination, which is invalid) and `SafeStorageWrapper` (Electron `safeStorage` or libsecret on Linux via a small adapter); recovery key (BIP39-style words) shown once; lock after idle; `unlock(reason)` triggers Touch ID through the helper.
- **Items**: kinds `login | api_key | oauth_token | ssh_key | note | payment_link`; bindings (origins, hosts, connector ids); refuse card numbers and government IDs with a Luhn/pattern check and an explanation; CSV import from 1Password / Bitwarden / Chrome exports; metadata mirror in the main DB for listing without unlocking.
- **Placeholders**: `{{cred:<slug>}}`, `.username`, `.totp`, `.header`; a `redact(text)` that replaces any registered secret value with `•••` (used by S18's checker and by executors' output paths); `resolve(placeholder, target, approvalId)` that verifies the target matches a binding, verifies the approval through `PermissionBroker`, returns the secret only to the calling executor through a one-shot handle (never a string that can be logged), and records a `credential_uses` row.
- **Fill protocol helpers** for executors: a browser fill routine that the browser package calls with a CDP session (`Input.insertText` into the focused field only when `origin` matches; clear on failure; report `secureField` state so screenshots are suppressed), an HTTP header injector for connectors, and an env injector for the sandbox runner.
- **Approvals**: every resolve is an `ApprovalRequest` of kind `credential_fill` (item, site, task, agent) with default scope `once` and opt-in `site`; desktop/OS notifications must require authentication (flag on the request).
- **OAuth tokens**: connector-owned items with refresh handled by the connector through a `rotate()` API; disconnect revokes and emits an event so pending connection-bound work is invalidated.
- **API handlers**: `vault.*` (metadata, add/edit/delete, import, uses, unlock/lock) for the Gateway; events `vault.locked/unlocked`, `credential.updated`.

## Out of scope
UI (S12), the Stripe Link flow (G12, M3), 1Password/Bitwarden bridges (G10/G11, later in this session's M2/M3 list).

## Definition of done
- Tests: vault create/unlock/lock; wrapped key round trip with both wrappers (fake helper); refused item kinds; import formats; placeholder parsing and redaction (property test: no registered secret survives `redact`); resolve denied on origin mismatch, missing approval, expired approval; one-shot handle cannot be read twice; use log; rotation; disconnect invalidation event.
- Threat-model checklist in the README mapping each control to `docs/05` §4; `docs/status/s06.md`.

## Suggested subagents
One to evaluate SQLCipher bindings for Node 24 (build, licensing, maintenance), one to write the redaction property tests, one adversarial reviewer (then Codex C3).

## M2/M3 follow-ons
G9 system-keychain mode (items as keychain entries through the helper); G12 Stripe Link Agent Wallet (spend request → approval URL → one-time card written only to a 0600 file consumed by the browser fill executor); G10 1Password service-account SDK bridge; G11 Bitwarden Agent Access bridge.
