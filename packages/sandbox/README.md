# @psyche/sandbox

**Owner:** S21 (`prompts/s21-sandbox.md`). Feature ids: K1–K3, K8 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

Container runner backends (Apple `container`, Docker, Colima), image, receipts, `srt` wrapper.

## Status

Placeholder created by S00 (bootstrap). `createSandboxRunner()` throws `NotImplementedError` until C1 lands the real `SandboxRunner` implementation.

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md)
- Security rules: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md)
- Contract: `packages/protocol/src/contracts/SandboxRunner.ts`, fake: `packages/testing/src/fakes/FakeSandboxRunner.ts`

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
