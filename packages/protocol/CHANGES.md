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

### 2026-10-19 — browser bridge amendments and `view.report` (S11)

Needed by S11 (desktop) and S08 (CDP driver); from `docs/spikes/spike-01-cdp-bridge.md`.

- `BRIDGE_MAX_FRAME_BYTES` (16 MiB) and `parseFrame(raw, { maxBytes })`: raw AX trees exceed 1 MiB. Other transports keep `MAX_FRAME_BYTES`.
- `ErrorCode` gains `user_in_control`, `debugger_detached`, `tab_not_found`, `method_not_allowed`.
- `BridgeTab` gains optional `openerTabId`, `disposition`, `taskId`; `bridge.tab.open` gains optional `taskId`, `taskTitle`.
- New method `bridge.tab.status` (Gateway → desktop): status pill text and the action highlight rectangle (I5).
- `bridge.control.changed` gains optional `via` (`keyboard | mouse | button | release | idle`); new event `bridge.debugger.detached {tabId, reason}`.
- New method `view.report {layout}` (desktop → Gateway) so `view.layout` has something to return.

### v1 additive — 2026-10-19 (S02 agent runtime)

- `AgentLoop.explainContext?(runId)` returning `ContextExplanation` (system prompt, ordered `ContextSection`s with budget / truncated / missing / untrusted flags, tools, message count) for the prompt viewer (feature C11).
- `ToolRegistration.describeCall?(params)` returning `ToolCallDescription` (`sideEffect`, approval `kind`, canonical `target`, `bindingFields`, `grantKey`, `summary`): the per-call facts the agent loop passes to `PermissionBroker.decide`. It may only make a call stricter than its spec.
- `MemoryStore.flush?(threadId, privateCopy, {taint})` returning `{appended}`: the pre-compaction memory flush (architecture §4.2 step 7, feature B7). `FakeMemoryStore` records calls in `flushes` and notes user lines starting with `remember:`.
- `FakeAgentLoop.explainContext` returns a one-section explanation for recorded runs.

### v1 additive — 2026-10-19 (S07 memory)

- `PROTECTED_MEMORY_FILES` gains `AGENTS.md` (security §8 names it as a protected path; S20 templates rely on it).
- `memory.search` takes optional `provenance` and `sources` filters; `memory.read` / `memory.write` return an optional `etag`, and `memory.write` takes an optional `etag` (if-match → `conflict`).
- New methods for the Soul & Memory sheet (architecture §4.8, feature H7): `memory.files.list`, `memory.daily.list`, `memory.claims.list`, `memory.claims.confirm`, `memory.explain`, `memory.forget`, `memory.remember`, `memory.import`, `memory.export`, `memory.reset` (`operator.admin`), `memory.status`, `memory.pause`.
- New schemas `MemoryFileInfo`, `MemoryJob` (`MemoryJobKind`, `MemoryJobStatus`), `MemoryChangeSource`; `ForgetResult.files` (optional).
- New events `memory.file.changed` and `memory.job.updated`.

### v1 — 2026-10-18 (S00 bootstrap)

- Domain schemas from `docs/04-data-model.md`; WS frames (`req` / `res` / `event` with `seq` and `stateVersion`); the M1 method and event registry; pairing handshake (`connect`, `connect.verify`); node protocol; desktop ↔ Gateway browser bridge; contract interfaces in `src/contracts/`; codegen to JSON Schema, TypeScript declarations and Swift `Codable` models.
