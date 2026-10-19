# @psyche/scheduler

**Owner:** S04 (`prompts/s04-*.md`). Feature ids: O1, O4 (O2, O3) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

Automations, heartbeat, watches, catch-up after sleep.

## Status

Placeholder created by S00 (bootstrap). `createScheduler()` throws `NotImplementedError` until S04 lands the real `Scheduler` implementation.

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md)
- Security rules: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md)
- Contract: `packages/protocol/src/contracts/Scheduler.ts`, fake: `packages/testing/src/fakes/FakeScheduler.ts`

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
