# @psyche/channels

**Owner:** S10 (`prompts/s10-*.md`). Feature ids: N1–N4 (N5, N10, N11) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

Channel framework, WebChat, Telegram; iMessage glue later.

## Status

Placeholder created by S00 (bootstrap). `createChannelAdapter()` throws `NotImplementedError` until S10 lands the real `ChannelAdapter` implementation.

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md)
- Security rules: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md)
- Contract: `packages/protocol/src/contracts/ChannelAdapter.ts`, fake: `packages/testing/src/fakes/FakeChannelAdapter.ts`

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
