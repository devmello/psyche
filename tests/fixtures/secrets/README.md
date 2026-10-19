# Secret fixtures

**Owner:** S18. Spec: [docs/05-security-and-permissions.md](../../../docs/05-security-and-permissions.md) §4.4 (refused item kinds), §4.5 (placeholder grammar), §4.7 (post-fill masking), §14 (logs), §15.4 item 7 (secret-scrubbing tests). Feature ids: G4 ("grep of all model-visible text in tests finds no secret"), cross-cutting "No secret in model-visible text".

`registry.json` is the one list of fake credentials, cards and tokens that every Psyche test uses. Nothing in it is real. Secret values are stored as recipes (`{"derive": {"prefix", "alphabet", "length"}}`) and materialized by [`derive.mjs`](derive.mjs) (and `packages/testing/src/secret-registry.ts`) from a SHA-256 of the item id and field, so no secret-looking literal is committed for GitGuardian or the secret-grep gate to flag, yet every value is fixed and exact. Usernames, published test card numbers and pattern samples stay literal.

| Section | What it holds | How tests use it |
| --- | --- | --- |
| `vaultItems` | Vault items in the shape of docs/05 §4.4 (`login`, `api_key`, `token`, `oauth_token`, `ssh_key`, `signing_key`, `note`) with bound origins / hosts and field values | Seed `FakeCredentialBroker` and the real vault in contract tests; the model sees only `{{cred:<id>}}` / `{{cred:<id>.<field>}}` |
| `standalone` | Secrets that are not vault items: device and bootstrap tokens, approval answer tokens, the recovery key, a session cookie, a Link virtual card and CVC | Seed Gateway, pairing, approval and payment tests |
| `patternSamples` | Values the leak checker must catch **by pattern** without registration (Luhn-valid cards, SSNs, IBANs, US routing + account, passports, private-key blocks), look-alikes it must not flag, valid placeholders it must not flag, and malformed placeholders executors must reject | Unit tests for the pattern detectors; false-positive guard |

## Rules

- Every value is at least 6 characters (`MIN_SECRET_LENGTH` in `packages/testing/src/secrets.ts`), so the checker can register it.
- Token values carry a `psyfx` / `fx-` marker and avoid real provider prefixes (`ghp_`, `sk_live_`, `AKIA`, `xoxb-`), so GitHub push protection and external scanners do not fire on the repo, and a hit in a log is obviously a fixture.
- Card numbers are the networks' published test numbers (Stripe's documentation lists them); they are Luhn-valid on purpose because the pattern detector must catch real-shaped cards.
- Government identifiers use known-invalid or documentation values (`078-05-1120`, `219-09-9999`, the ECBS example IBAN).
- Add a value here, never inline in a test: a secret that is not in the registry is a secret the checker cannot look for. The secret-leak checker loads every value in `vaultItems[*].fields` and `standalone[*].value` at startup.
- Placeholder ids follow docs/05 §4.5: `[a-z0-9][a-z0-9-]{0,63}`, fields `username | password | totp | token | header`. `google-oauth.refresh` is stored on the item but deliberately has no placeholder field: refresh tokens are connector-internal and never addressable by the model.
- Bound origins use the reserved `.example` TLD, never `.test` or `localhost`: docs/05 §3.10 lets test credentials be typed on `.test` hosts, so a fixture bound to one could be mistaken for the localhost exception.
