# @psyche/search

**Owner:** S16 (`prompts/s16-*.md`). Feature ids: S1 (S2) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

Unified index and query across threads, tasks, memory, library, feed.

## Status

Placeholder created by S00 (bootstrap). `createSearchIndex()` throws `NotImplementedError` until S16 lands the real `SearchIndex` implementation.

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md)
- Security rules: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md)
- Contract: `packages/protocol/src/contracts/SearchIndex.ts`, fake: `packages/testing/src/fakes/FakeSearchIndex.ts`

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
