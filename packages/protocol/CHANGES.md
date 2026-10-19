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

### v1 additive — 2026-10-19 (S01 Gateway core)

- **Security fix, behavior change (needs S00 sign-off):** `isAdminSettingKey` is now an allowlist. Every key needs `operator.admin` unless it is under one of `USER_SETTING_PREFIXES` (`appearance`, `ui`, `editor`, `shortcuts`, `locale`, `notifications.sound`, `notifications.badges`), matched by whole segments, case-insensitively. New export `isUserSettingKey`. `ADMIN_SETTING_ROOTS` stays exported for reference. Fixes S23 review PR-1-C (owner identity, sessions, MCP, connectors, skills, plugins, models, updates, browser, VM, memory and backup keys were writable with `operator.write`).
- `PairingRequest`: optional `publicKeyFingerprint` (`sha256:<hex>` of the raw key), `transport` (`ws | unix`) and `remoteAddress`, so the owner approves a key, not a name (S23 review PR-1-B).
- `devices.approve`: optional `code`; when present it must equal the code shown on the new device.
- `threads.list`: optional `query`, a case-insensitive substring match on titles (feature E1 "search").
- `thread.deleted` event so every client drops a deleted thread (feature N14).
- `chat.queue.list` / `chat.queue.remove`, the `QueuedMessage` schema and the `chat.queue.updated` event: the follow-up queue is visible and removable (feature E3).
- `AgentLoop`: `AgentEvent` `tool_call` gains optional `details: ToolCallDetails` (redacted params, params hash, side effect, target, decision, approval, taint, provenance, receipt) so the Gateway can persist `tool_calls` rows and emit full `tool_call.updated` payloads. Needed by S01; S02 fills it.

### v1 — 2026-10-18 (S00 bootstrap)

- Domain schemas from `docs/04-data-model.md`; WS frames (`req` / `res` / `event` with `seq` and `stateVersion`); the M1 method and event registry; pairing handshake (`connect`, `connect.verify`); node protocol; desktop ↔ Gateway browser bridge; contract interfaces in `src/contracts/`; codegen to JSON Schema, TypeScript declarations and Swift `Codable` models.
