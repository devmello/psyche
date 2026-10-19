# @psyche/tasks

**Owner:** S04 (`prompts/s04-*.md`). Feature ids: D1–D3, D6 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

Durable task engine: plans, steps, checkpoints, leases, input requests, activity log.

## Status

Placeholder created by S00 (bootstrap). `createTaskEngine()` throws `NotImplementedError` until S04 lands the real `TaskEngine` implementation.

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md)
- Security rules: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md)
- Contract: `packages/protocol/src/contracts/TaskEngine.ts`, fake: `packages/testing/src/fakes/FakeTaskEngine.ts`

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
