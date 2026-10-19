# @psyche/notifications

**Owner:** S15 (`prompts/s15-*.md`). Feature ids: O10 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

Notification model and delivery routing.

## Status

Placeholder created by S00 (bootstrap). `createNotifier()` throws `NotImplementedError` until S15 lands the real `Notifier` implementation.

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md)
- Security rules: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md)
- Contract: `packages/protocol/src/contracts/Notifier.ts`, fake: `packages/testing/src/fakes/FakeNotifier.ts`

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
