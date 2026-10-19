# @psyche/permissions

**Owner:** S05 (`prompts/s05-*.md`). Feature ids: F1–F12, U3 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

Policy engine, approvals, grants, binding hashes, classifier hook.

## Status

Placeholder created by S00 (bootstrap). `createPermissionBroker()` throws `NotImplementedError` until S05 lands the real `PermissionBroker` implementation.

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md)
- Security rules: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md)
- Contract: `packages/protocol/src/contracts/PermissionBroker.ts`, fake: `packages/testing/src/fakes/FakePermissionBroker.ts`

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
