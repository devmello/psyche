# @psyche/agent-core

**Owner:** S02 (`prompts/s02-*.md`). Feature ids: C1–C5, C8, C9, C11, B7 (C6, C7) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

The agent loop: steer/follow-up queues, tool registry, context assembly, compaction, `ask_user`, plan and checklist.

## Status

Placeholder created by S00 (bootstrap). `createAgentLoop()` throws `NotImplementedError` until S02 lands the real `AgentLoop` implementation.

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md)
- Security rules: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md)
- Contract: `packages/protocol/src/contracts/AgentLoop.ts`, fake: `packages/testing/src/fakes/FakeAgentLoop.ts`

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
