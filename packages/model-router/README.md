# @psyche/model-router

**Owner:** S03 (`prompts/s03-*.md`). Feature ids: B1–B6 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

Provider adapters on AI SDK v7, the router (roles, fallbacks, cooldowns), usage ledger, price table, capability probe.

## Status

Placeholder created by S00 (bootstrap). `createModelRouter()` throws `NotImplementedError` until S03 lands the real `ModelProvider` implementation.

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md)
- Security rules: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md)
- Contract: `packages/protocol/src/contracts/ModelProvider.ts`, fake: `packages/testing/src/fakes/FakeModelProvider.ts`

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
