# @psyche/browser

**Owner:** S08 (`prompts/s08-*.md`). Feature ids: I2–I4, I7–I9, I15 (I10, I12–I14) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

`BrowserDriver` implementations (CDP, Playwright), snapshots, origin policy, bridge protocol client.

## Status

Placeholder created by S00 (bootstrap). `createBrowserDriver()` throws `NotImplementedError` until S08 lands the real `BrowserDriver` implementation.

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md)
- Security rules: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md)
- Contract: `packages/protocol/src/contracts/BrowserDriver.ts`, fake: `packages/testing/src/fakes/FakeBrowserDriver.ts`

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
