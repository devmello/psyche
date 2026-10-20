# @psyche/vault

**Owner:** S06 (`prompts/s06-vault.md`). Features G1–G7, G9, G13, G14 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md). G8 belongs to the browser; G10–G12 are later milestones.

The Credential Broker: an encrypted vault the model never reads. The model sees `{{cred:<slug>}}` placeholders and metadata. Executors (browser fill, connector HTTP, sandbox env) resolve a placeholder only for a matching target, only with an approved `credential_fill`, and receive a one-shot `ResolvedSecret` handle, never a string.

## Public API (`src/index.ts`)

- **`Vault`**: implements `CredentialBroker` and `ConnectorCredentialStore` from `@psyche/protocol`.
  - Lifecycle: `setup()` returns the recovery key, once. Also `confirmRecovery(lastGroup)`, `unlock(reason)` (Touch ID through the helper), `unlockWithRecovery(key)`, `lock(reason)`, `status()`, `primarySlot`. The vault locks itself after `autoLockMinutes` idle (default 480).
  - Items: `add`, `update`, `delete`, `importCsv(csv, "auto" | "1password" | "bitwarden" | "chrome")`, `uses(id, limit = 50)`. `list` and `get` read the metadata mirror, so they work while the vault is locked.
  - Broker: `resolve(placeholder, target, approvalId, {executor, element, selector, taskId})`, `redact(text)`, `containsSecret(text)`, `requestFill(...)` (builds the approval request and sends it), `headerName(slug)`.
  - Connector tokens: `store`, `accessToken`, `rotate(id, connector, refresher)`, `revoke`, `onRevoked`.
  - Events: `on("vault.locked" | "vault.unlocked" | "credential.updated", fn)`. Payloads match the protocol event schemas.
- **Key slots:** the `KeyWrapper` interface, with `KeychainWrapper` (mac helper), `SafeStorageWrapper` (an adapter over Electron `safeStorage` or libsecret) and `KeyFileWrapper` (server mode).
- **Executor helpers:**
  - `fillBrowserField({cdp, broker, placeholder, approvalId, selector, backendNodeId})` and `clearFocusedField(cdp)`.
  - `authorizedFetch({broker, placeholder, approvalId, url, headerName})`, `safeHttpError(err, redact)` and `redactedText(res, redact)`.
  - `buildSecretEnv({broker, entries, target})`.
- **Approvals:** `credentialFillApproval(req)` returns the `ApprovalRequestInput`. `credentialFillBindingHash` and `credentialFillGrantKey` compute the same hash and grant key that the vault recomputes at resolve time.
- **Gateway:** `createVaultHandlers(vault)` serves every `vault.*` method in the protocol registry.
- **Building blocks:** `SecretRedactor`, `encodingsOf`, `scanText` / `findRefusal` / `luhnValid`, `parseCsv` / `importRows`, `parseTotpSeed` / `totpCode`, `VaultStore`, `SqliteMetaMirror`, `strictCanonicalJSON`, `canonicalOrigin`, `bindingMatches`.

### Wiring (S01)

```ts
const vault = new Vault({
  home: PSYCHE_HOME,
  wrapper: new KeychainWrapper({ helper: macHelperNode, account: "default" }), // or SafeStorageWrapper / KeyFileWrapper
  meta: new SqliteMetaMirror(psycheDb.sqlite),
  permissions,                 // S05 PermissionBroker
  audit,                       // S05 AuditLog
});
const handlers = createVaultHandlers(vault);
vault.on("credential.updated", (p) => events.publish("credential.updated", p));
```

Do not log the params of `vault.add`, `vault.update`, `vault.import` or `vault.unlock`. They carry secrets or the recovery key.

### Resolve order

1. Screen the request against the metadata mirror:
   - the placeholder must match the grammar exactly (`invalid_params`), and the item must exist (`not_found`);
   - an approval id must be present;
   - the item must not be connector-owned;
   - the target must match a binding: the exact origin, a declared `https://*.domain` pattern (refused over shared or public suffixes such as `github.io` or `co.uk`), the host over HTTPS only, or the connector account; opaque origins never match;
   - browser fills only: the element is required, its frame origin and its form's action origin (including every submitter's `formaction`) must both equal the target, and the field class must fit (`fillElementAccepts`: a password only into `type=password`).
2. If the vault is locked, unlock it with a Touch ID prompt naming the item and site. With `unlockOnFill: false`, fail.
3. Re-check against the encrypted store, which is authoritative: owner, bindings, kind, and that the field exists. A tampered mirror row changes nothing.
4. Items flagged `requireAuthEachUse` (SSH keys by default) prompt again here.
5. `PermissionBroker.verifyBinding(approvalId, hash)`, where the hash covers item id, target, field, executor, selector and element (security §3.5). The approval must be a `credential_fill`. This is the only step that consumes a `once` approval: nothing that can fail without it (lock, cancelled Touch ID, missing field) runs after it.
6. Read the value: `.totp` gives the current code, never the seed; `.header` gives the prefix plus the token. The value becomes sticky in the redactor. A `credential_uses` row and a `credential.filled` audit entry are written.

Each denial writes a `denied` use row with the reason and a `credential.fill_denied` audit entry. Each failure (locked, unlock refused, no such field) writes a `failed` row.

The `site` grant key is `credential_fill|<item>|<origin>|<field class>|<executor>`, so a browser login grant never covers a sandbox or connector use of the same password.

`fillBrowserField` re-reads the top-frame origin and checks that the approved node still has focus *after* `resolve` returns. Resolve can wait seconds on Touch ID, and the page may have navigated in that time. It reports `secureField: true` for every fill.

### Mac helper contract (S14)

| Capability | Params | Result |
| --- | --- | --- |
| `keychain.set` | `KeychainSetParams`: service, account, base64 value, `accessControl: ["biometryCurrentSet","or","devicePasscode"]`, `accessible: "whenPasscodeSetThisDeviceOnly"`, `synchronizable: false`, `dataProtection: true` | `{}` |
| `vault.unlock` | `VaultUnlockParams`: service, account, `reason` (prompt text), `reuseDurationSeconds` (0) | `{value}` base64; error `cancelled` when the user cancels |
| `keychain.delete` | service, account | `{}`. Declared `destructive`, so `KeychainWrapper.destroy(wrapped, approvalId)` needs an approved id |
| `keychain.status` | `{}` | `{dataProtectionKeychain: "available" \| "missing_entitlement" \| "error", accessGroup, biometry}` |

These four are registered on main (PR #47). System keychain mode (G9) also needs the item capabilities. They are specified in `KeychainCapabilities.swift` (`store`, `retrieve`) but **not yet registered** in `KeychainCapabilities.make`:

| Capability | Params | Result |
| --- | --- | --- |
| `keychain.store` | `name` (`^[a-z0-9._-]{1,64}$`), `value` base64url (≤16 KiB), `requireAuth` (default true), `replace`, `reason` | `{name, stored, requireAuth, replaced}`; `conflict`/`duplicate_item` |
| `keychain.retrieve` | `name`, `reason` (prompt, 1–120 chars) | `{name, value}` base64url, a secret; `cancelled`/`user_cancelled`, `not_found`/`item_not_found` |
| `keychain.delete_item` | `name`, `reason` | `{deleted}`; `not_found` counts as already deleted. A separate name, because `keychain.delete` is the vault-key delete. Should be `write`: the vault calls it while serving an `operator.admin` `vault.delete` |

`KeychainItemStore` checks for these capabilities and for `keychain.status` = `available`, and fails with `unavailable` until they exist. Errors arrive as `{code, message, details: {reason}}`. The vault keeps the code and the reason and drops the helper's message. The agent has no tool for any of these, and `nodes.invoke` must not reach them (S23 pr-1 note).

### System keychain mode (G9)

`new Vault({ ..., itemBackend: "keychain", keychainItems: new KeychainItemStore({ helper }) })` puts the secrets of new items (from `add` and `importCsv`) in the data-protection keychain as `psyche.item.<id>`. These live in Psyche's own access group; Safari and Passwords items are never read.

- **Database row:** the vault database row keeps name, bindings, attributes and the list of fields present. Its `secret` is `{}`.
- **Resolve:**
  - checks the field from that list without prompting;
  - reads the item with `keychain.retrieve`; this prompts with "Fill “<item>” on <origin>" and is the fill's presence check;
  - all of this happens before the approval is consumed, so a cancelled prompt leaves the approval usable and writes a `failed:keychain_refused` use row.
- **Edits** read the item (one "Edit “<item>”" prompt) and replace it. **Deletes** remove the keychain item first.
- **Moving items:** `setBackend(id, "vault" | "keychain")` moves one item either way. `backendOf(id)` reports where its secret lives.
- **Connector OAuth tokens** stay in the vault, because they refresh unattended.

**Trade-off:** keychain items are protected by `biometryCurrentSet` or the passcode. If re-enrolling Touch ID invalidates them, the recovery key cannot bring them back (they are not in `vault.db`). Move them back with `setBackend(id, "vault")` before re-enrolling. This is also recorded as an open question in docs/status/s06.md.

### 1Password as an external source (G10)

`new Vault({ ..., onePassword: new OpCliSource({ op, token }) })`, or `new OpConnectSource({ baseUrl, token })`. Then `vault.linkOnePassword({ kind, name, slug, bindings, ref: { vault, item }, fields })` links an item. Psyche stores only the reference, the bindings and the list of fields offered. The agent uses the normal `{{cred:<slug>[.field]}}` placeholders.

- **Reads:**
  - `resolve` runs every usual check: grammar, binding, element, field listed.
  - It reads the one requested field only *after* `verifyBinding`, so a bogus approval or a wrong origin never touches 1Password.
  - `.totp` returns 1Password's current code (`?attribute=otp`, or Connect's `totp`).
  - Values are registered with the redactor; a failed read writes a `failed:external_unavailable` use row.
- **Read-only:** secret edits and `setBackend` are refused. `delete` only unlinks, and nothing is ever written to 1Password.
- **`OpCliSource`:** runs `op read "op://<vault>/<item>/<field>" --no-newline` with no shell. `OP_SERVICE_ACCOUNT_TOKEN` is set only in the child's env, next to PATH and HOME. Errors carry neither output nor token.
- **`OpConnectSource`:** talks to Connect over https (or http on loopback). It resolves vault and item names through `filter=name|title eq "…"`, sends a Bearer token per request, and does not follow redirects. A 404 or an ambiguous name becomes `not_found`.
- **References:** names containing `/ ? # "`, a backslash or control characters are refused, so a reference cannot escape the `op://` path or the Connect filter.
- **Token:** keep the service-account or Connect token in the vault as a connector-owned item (`vault.store({ connectorId: "onepassword", … })`), and pass `token: () => vault.accessToken(id, "onepassword")`.

### Payments through Stripe Link (G12)

`PaymentBroker({ home, wallet: new LinkCliWallet({ cli, env }), permissions, redactor, audit })` implements security §4.9 in five steps:

1. **`requestPurchase(input, {requestedBy, taint})`** issues a `purchase` ApprovalRequest:
   - financial and device-only, `once` only, with authentication required;
   - bound to merchant host + amount (minor units) + currency + line-item hash + payment source (`purchaseBindingHash`, security §3.5);
   - refused up front over Link's $500 ceiling or the owner's `agent_wallet_spend_limits.per_transaction`.
2. **`authorize(approvalId, input)`** recomputes the binding and calls `verifyBinding`, which consumes the approval. It then creates the Link spend request with `--request-approval`. The context Link shows the owner is written by Psyche from the approved facts (`spendContext`), never from agent or page text.
3. **`awaitCard(id)`** waits for the owner's decision in Link (30-minute window). On `approved`, Link writes the one-time card to `vault/cards/<id>.json` (0600, directory 0700; anything wider is shredded and refused). Only brand, last4 and expiry come back; number and CVC go to the shared redactor.
4. **`fillCard({cdp, spendRequestId, field})`** types one card field through the shared fill core (`fillFocused`):
   - the top frame must be the merchant's https host or one of its subdomains;
   - the focused input must match that field (`cc-number`, `cc-exp*`, `cc-csc`, `cc-name`, `postal-code`, or a matching `name`/`id`);
   - the field must not sit in another frame (Stripe Elements' `js.stripe.com` iframe is refused; a Link Pay Token is the follow-up for those checkouts).
5. **`complete(id, {outcome, orderNumber, merchantConfirmation})`** shreds the card file, reports the outcome to Link, and records the receipt. The receipt has `externalRefs.linkSpendRequestId` / `orderNumber` / `merchantConfirmation` and a payload with brand / last4 only.

**Purchases the agent loop dispatched:** a purchase tool, such as V3's `shop.pay_with_link`, has its `once` purchase card issued, verified and consumed by the loop under the loop's binding recipe. `authorizeDispatched(approvalId, input, bindingHash)` re-checks that request itself before creating the spend request:
- approved, kind `purchase`, scope `once`;
- the same binding hash the loop verified for these exact arguments;
- one spend request per approval.

`complete({..., toolCallId})` ties the receipt to that tool call.

**Clean-up:** `cancel(id)` cancels and shreds. `sweep()` shreds card files past `cardTtlMs` (2 h) and any file without a live approved record. Records (no secrets) live in `vault/payments/`.

**`LinkCliWallet`** runs the owner-installed `@stripe/link-cli` (0.29.0 checked; deliberately not a dependency, because its postinstall runs a skills installer):
- no shell, `--format json`, and only `PATH`, `HOME` and the given env (`LINK_AUTH_FILE`);
- card details travel only through `--include card --output-file`;
- CLI failures become `unavailable` without its output.

The card's 3-digit CVC is shorter than the redactor's minimum, so it is protected by never leaving the 0600 file and the fill, not by masking.

### Connector OAuth tokens for `@psyche/connectors` (G13)

`new VaultTokenVault(vault, { bindings })` matches connectors' `TokenVault` (`load` / `save` / `clear`). It is typed structurally, so the vault does not import the connectors package.

- **`save`:** creates an `oauth_token` item owned by the connector, `connector-<id>`, bound to `{connector: <id>}` plus any API hosts. Later saves replace the whole token set atomically (`replaceConnectorTokens`); old values stay masked for the life of the process.
- **`load`:** reads through `connectorTokens`, which checks the owner and records a `connector` use row.
- **`clear` (disconnect):** revokes the item. This emits `onRevoked` and `credential.updated {change: "revoked"}`, so connection-bound work is invalidated.
- **While locked:** reads fail `unavailable`.
- **Gateway:** replace `MemoryTokenVault` in `apps/gateway/src/compose/connectors.ts` with `new VaultTokenVault(vault)`.

## How it maps to the docs

| Doc | Where |
| --- | --- |
| 05 §4.1 vault format | `store.ts`: SQLCipher 4 page format through SQLite3 Multiple Ciphers (`cipher=sqlcipher`, `legacy=4`), raw 32-byte key, `secure_delete=ON`, WAL checkpointed on delete and close |
| 05 §4.2 key wrapping | `slots/*`, `vault.ts` `setup` / `unlockWithRecovery`. The recovery key is 32 random bytes in grouped base32; it wraps the DEK under Argon2id (`node:crypto` `argon2Sync`), sealed with AES-256-GCM in `vault/recovery.slot` |
| 05 §4.3 unlock flows | `unlock`, idle lock, `unlockOnFill`, `requireAuthEachUse`; server mode is `KeyFileWrapper` |
| 05 §4.4 kinds and refusals | `refusals.ts` (Luhn plus issuer prefixes, CVV, IBAN mod-97, routing / account keywords, SSN, UK NINO, id keywords) and `vault.ts` `add` |
| 05 §4.5 placeholders | `resolve`; grammar from `PLACEHOLDER_PATTERN` |
| 05 §4.6 fill protocol | `fill/browser.ts`, `fill/http.ts`, `fill/env.ts` |
| 05 §4.7 post-fill hygiene | `redact.ts` (exact plus fuzzy forms; sticky values), `clearFocusedField`, `secureField` |
| 05 §4.8 OAuth | the `ConnectorCredentialStore` half of `Vault` |
| 05 §4.10 audit | `credential.filled` / `credential.fill_denied` audit entries and `credential_uses` rows |
| 05 §14 data handling | 0600 files in a 0700 directory, overwrite before delete, `secure_delete` |
| 04 §6 | `items` in `vault.db`; `credential_meta` and `credential_uses` in `packages/db/migrations/202610191000_vault_credentials.sql` |

## Threat-model checklist (05 §4)

| Control | Doc | Enforced by | Test |
| --- | --- | --- | --- |
| A copied `vault.db` is useless without the keychain item or the recovery key | §4.1–4.2, G1 | random DEK; slots sealed with AES-GCM with the slot bound in the AAD | `lifecycle`: "a copied vault.db is useless…" |
| Keychain item uses `[.biometryCurrentSet, .or, .devicePasscode]`, this-device-only | §4.2 | `KEYCHAIN_ACCESS_CONTROL` and `keychain.set` params | `lifecycle`: access control |
| `safeStorage` refused on `basic_text` | §4.2 | `SafeStorageWrapper.unavailableReason` | `lifecycle`: key wrappers |
| Key file must be 0600 | §4.3 | `KeyFileWrapper` | `lifecycle`: key file |
| Recovery key shown once and confirmed | §4.2 | `setup` returns it, never stores it in plaintext; `confirmRecovery` | `lifecycle`: recovery |
| DEK zeroized on lock; idle lock | §4.3 | `lock`, `#touch` / `#checkIdle` | `lifecycle`: idle |
| Touch ID per fill for `requireAuthEachUse` | §4.3 | `resolve` step 6 | `resolve`: presence on every use |
| No card numbers, CVVs, bank accounts or government ids | §4.4, G2 | `findRefusal` in `add` / `update` / import, with an explanation pointing to Stripe Link | `items`, `import` |
| Model sees placeholders and metadata only | §4.5, G4 | `list` / `get` / events / audit carry no values | `items`, `handlers` (`assertNoSecrets`) |
| Exact origin or host match; opaque origins refused | §4.5, G5, S23-13 | `bindingMatches`, `bindingProblem` | `resolve`, `s23-review` |
| Approval bound to the exact fill, once by default, site opt-in | §3.5, §4.5, G7 | binding hash recomputed in `resolve`; `verifyBinding` | `resolve`: denials |
| Field class: no password in a comment box | S23-01 | `fillElementAccepts`, frame / form-action checks, field class in the grant key | `s23-review` design-01, conformance |
| Value never a loggable string | contract | `ResolvedSecret`, one-shot | `resolve`, conformance |
| Browser: top-frame origin, focused approved node, no Take control, clear on failure, `secureField` | §4.6–4.7, G6 | `fillBrowserField` | `fill`: browser |
| HTTP: HTTPS only, bound host, header kept only on same-origin hops, errors rebuilt | §4.6, S23-16 | `authorizedFetch`, `safeHttpError` | `fill`: connector HTTP |
| Sandbox: per-command env only, nothing inherited | §4.6, S23-17 | `buildSecretEnv` | `fill`: sandbox env, `s23-review` design-17 |
| Masking of echoes and encodings | §4.7, S23-15/16/18 | `SecretRedactor`: exact forms (URL, form, JSON, HTML, base64 at three alignments, hex, base32, reversed, ROT13, base64 of the reversed value, long-key prefix and suffix) plus a fuzzy NFKC / case-fold / separator-stripping pass; sticky after lock | `redact` property tests, `s23-review` |
| OAuth: owner-only, atomic rotation, revoke emits invalidation | §4.8, G13 | `store` / `accessToken` / `rotate` / `revoke` / `onRevoked` | `oauth` |
| Every fill and denial audited; last 50 uses per item | §4.10, G14 | `credential_uses`, audit entries | `items`: uses, `resolve` |

## What is stubbed or deferred

- **Passphrase mode** (server without a key file): not built. `KeyFileWrapper` covers server mode.
- **Bitwarden (G11)**: later. G10 open items: protocol methods to link 1Password items from the UI, and live tests behind `PSYCHE_LIVE_TESTS=1`. G12 open items: a Link Pay Token for Stripe-hosted checkouts, Link OAuth tokens held in the vault instead of the CLI's auth file, and wiring a `purchase` tool (S02 / S08). G9 waits on the helper registering its item capabilities (above), and no protocol method switches the backend yet (`setBackend` is in-process only). `payment_link` and `signing_key` items are refused at `add`.
- **VM guest release (S23 design-05)**: no guest path exists yet. The review's controls (`vmAllowed`, once only, Touch ID each time, a rate limit) are a `todo` in `test/s23-review.test.ts`.
- **Post-fill tab rules (S23 design-18)**: refusing screenshots and aborting a tool result on an echo belong to S08. They call `containsSecret` / `redact`.
- **Fresh container per secret-bearing command (S23 design-15)**: S21.
- **Redaction cost** grows with items × forms × text length; fine for M1. An Aho-Corasick matcher is the upgrade path.
- **Sleep and screen-lock events** must call `vault.lock("sleep" | "screen_lock")` from the desktop or the helper (S11 / S14).

## Dependencies

- `better-sqlite3-multiple-ciphers@13.0.3` (MIT). Prebuilt binaries for darwin, linux, linuxmusl and win32 on x64 and arm64 ship in the tarball. `pnpm-workspace.yaml` sets its build to `false`, because the only "script" is pnpm's implicit `node-gyp rebuild`. Its `exports` map hides its types, so `src/types/` maps it to `@types/better-sqlite3`.
- `fast-check@4.10.2` (MIT, dev) for the property tests.
