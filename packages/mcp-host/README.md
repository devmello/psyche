# @psyche/mcp-host

**Owner:** S09 (`prompts/s09-*.md`). Feature ids: M1, M2, M5, M8, M11 (M3, M7, M10) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

MCP client host (spec 2026-07-28), trust tiers, tool policy integration.

## Status

Placeholder created by S00 (bootstrap). `createMcpHost()` throws `NotImplementedError` until S09 lands the real `McpHost` implementation.

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md)
- Security rules: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md)
- Contract: `packages/protocol/src/contracts/McpHost.ts`, fake: `packages/testing/src/fakes/FakeMcpHost.ts`

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
