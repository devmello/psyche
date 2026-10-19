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

### v1 additive — 2026-10-19 (S10 channels)

- `ChannelAdapter` (all optional, additive): `InboundMessage.identityStrength` (`weak` senders never match an owner, review design-21), `forwardedFrom`, `quoted`, `editOf`, `senderIsChat` (design-22); `ChannelAttachment.kind / ref / durationMs / data`; `OutboundMessage.format`; `ChannelCapabilities.typing / markdown`; adapter methods `sendTyping`, `fetchAttachment`, `health` (`ChannelHealth`). `FakeChannelAdapter` implements the new methods and records typing, attachments and format.
- Schema `ChannelIdentity` (data model §8 `identities`).
- Methods `channels.configure`, `channels.allowlist.update`, `channels.pairing.{list,approve,deny}`, `channels.identities.{list,upsert,delete}`; every change is `operator.admin` and side-effecting.
- Event `channels.updated`.

### v1 (additive) — 2026-10-19 (S12 UI kit)

Needed by `packages/ui` to render and answer every block type in data model §9.1 and the Feed, Ideas and Goals screens (UI design §3.4, §3.9–§3.11). Owners of the semantics: S02/S04 (questions), S05 (receipts, answer tokens), S15 (feed, ideas, goals).

- New methods: `questions.list`, `questions.get`, `questions.answer` (answers keyed by question `header`; side-effecting); `receipts.get`, `receipts.list`; `artifacts.get`; `feed.list` (with `nextBriefAt`), `feed.feedback` (`null` clears, for undo); `ideas.list`, `ideas.accept` (optional `recurring` and edited `brief`; side-effecting), `ideas.dismiss` (`not_now | not_interested | never_from_source`); `goals.list`, `goals.get` (with linked `taskIds`), `goals.decide` (`confirm | reject | later`).
- New events (appended): `question.updated`, `feed.post`, `idea.updated`, `goal.updated`.
- Optional `answerToken` on `approval.created` and on `approvals.get`'s result, and an optional `answerTokens` map on `approvals.list`'s result: the calling device's own single-use surface token (security §3.7), so a client can call `approvals.answer`. Never another surface's token.
### v1 (additive) — 2026-10-19 (S15 proactive, on top of S12's `feed.*` / `ideas.*` / `goals.*`)

- `feed.feedback` result gains optional `ledgerChanges` (the `interests.md` lines it changed, for the undo toast).
- New `feed.generate` (first-run "Generate the first one"), side-effecting.
- `ideas.accept` gains optional `schedule`, `timezone` (recurring accepts) and `threadId`.
- `goals.get` result gains optional `milestones` and `links`; new schemas `GoalMilestone`, `GoalLink` (data model §8).
- New `goals.create`, `goals.update`, `goals.archive`, `goals.milestone`, `goals.link` (all side-effecting). Inferred goals still only become active through S12's `goals.decide`.
- New event `feed.updated` (one per generated batch), alongside `feed.post`.

### v1 (additive) — 2026-10-19 (S15 notifications)

- Events `notification.updated` and `notification.resolved` (the inbox already emitted `notification.created`; read, de-duplicated updates, resolution and restart reconciliation had no event).
- `Notification.staleAt` / `staleReason` (optional, nullable): restart reconciliation marks stale notifications (architecture §4.12, UI §3.20).
- `NotificationAction.authenticationRequired` (optional): the mac helper shows the action with `authenticationRequired` (Touch ID) for purchase and credential-fill approvals (security §3.5, O10).
- No fake change: `FakeNotifier` already emits `created` / `updated` / `resolved`; the new fields are optional.

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
