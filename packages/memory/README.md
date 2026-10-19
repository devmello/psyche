# @psyche/memory

**Owner:** S07 (`prompts/s07-*.md`). Feature ids: H1–H5, H7, H8 (H6, H9, H10) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

Workspace files, FTS5 + sqlite-vec index, memory tools, pre-compaction flush, dreaming.

## Status

Placeholder created by S00 (bootstrap). `createMemoryStore()` throws `NotImplementedError` until S07 lands the real `MemoryStore` implementation.

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md)
- Security rules: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md)
- Contract: `packages/protocol/src/contracts/MemoryStore.ts`, fake: `packages/testing/src/fakes/FakeMemoryStore.ts`

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
