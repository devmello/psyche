# Protocol changes

`@psyche/protocol` is the contract every package, app and the Swift helper compile against. This file is its changelog and the description of how it changes.

## Process

1. Open a PR titled `protocol: <summary>` that touches only `packages/protocol/**`, the matching fake in `packages/testing/src/fakes/`, and the regenerated files (`pnpm protocol:gen` writes `packages/protocol/generated/**` and `apps/mac-helper/Sources/PsycheProtocol/PsycheProtocol.generated.swift`).
2. **Additive only until v1**: new optional fields, new types, new methods, new events, new enum values at the end of a list. Renaming or removing anything, making an optional field required, or narrowing a type needs the integrator's (S00) sign-off and a `PROTOCOL_VERSION` bump.
3. Add an entry below (newest first) naming the session that needs it and what changed.
4. Add a changeset (`pnpm changeset`, package `@psyche/protocol`).
5. The integrator merges `protocol:` PRs before anything else and rebases dependents. Until it merges, keep building against your local copy; never import another session's unmerged branch.

CI fails when the generated files are stale (`pnpm protocol:check`).

## Versioning

`PROTOCOL_VERSION` (in `src/version.ts`) is negotiated at `connect`: clients send a `{min, max}` range and the Gateway answers with the version it will speak or `protocol_version_mismatch`. It changes only for breaking changes.

## Log

### v1 (additive) — 2026-10-19 (S15 notifications)

- Events `notification.updated` and `notification.resolved` (the inbox already emitted `notification.created`; read, de-duplicated updates, resolution and restart reconciliation had no event).
- `Notification.staleAt` / `staleReason` (optional, nullable): restart reconciliation marks stale notifications (architecture §4.12, UI §3.20).
- `NotificationAction.authenticationRequired` (optional): the mac helper shows the action with `authenticationRequired` (Touch ID) for purchase and credential-fill approvals (security §3.5, O10).
- No fake change: `FakeNotifier` already emits `created` / `updated` / `resolved`; the new fields are optional.

### v1 — 2026-10-18 (S00 bootstrap)

- Domain schemas from `docs/04-data-model.md`; WS frames (`req` / `res` / `event` with `seq` and `stateVersion`); the M1 method and event registry; pairing handshake (`connect`, `connect.verify`); node protocol; desktop ↔ Gateway browser bridge; contract interfaces in `src/contracts/`; codegen to JSON Schema, TypeScript declarations and Swift `Codable` models.
