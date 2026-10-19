# @psyche/vault

**Owner:** S06 (`prompts/s06-*.md`). Feature ids: G1–G9, G13, G14 (G10–G12) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

SQLCipher vault, key wrapping, `{{cred:slug}}` placeholders, fill protocol.

## Status

Placeholder created by S00 (bootstrap). `createCredentialBroker()` throws `NotImplementedError` until S06 lands the real `CredentialBroker` implementation.

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md)
- Security rules: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md)
- Contract: `packages/protocol/src/contracts/CredentialBroker.ts`, fake: `packages/testing/src/fakes/FakeCredentialBroker.ts`

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
