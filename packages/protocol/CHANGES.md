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

### v1 additive — 2026-10-19 (P9 file tools, #49)

For `@psyche/files` and the approval cards (S11 / S12). `ToolCallDescription` gains optional `details?: JsonObject`: what the approval card shows besides the params, display only and never part of the binding. The agent loop spreads it into `ApprovalRequest.details` under `tool`, `params` and `target`, which it cannot override. `write_file` / `edit_file` use it for `{path, operation, diff}`, which the UI kit's `file_write` card already renders.
### v1 additive — 2026-10-19 (S02/S04: write-ahead dispatch hook, #63)

For S02 (`agent-core` awaits it before every dispatch) and S04 (`TaskWorkerPool` commits the step's `running` checkpoint in it).

- `StartTurnInput` gains optional `beforeDispatch(call: DispatchIntent) => Promise<void>`, awaited immediately before each tool call is dispatched (after the broker and any approval). A rejection blocks the call. New contract type `DispatchIntent` (`toolCallId`, `tool`, `sideEffect`, `approvalId?`). Contract-only (a function, not on the wire): no generated-file change.
- `FakeAgentLoop` awaits it before yielding a scripted `tool_call` `running` event and no longer records it in `turns`.

### v1 additive — 2026-10-19 (S05 M2: fresh presence on security settings)

For S05 (the Gateway's `settings.set`) and S11 (Settings). `settings.set` gains optional `approvalId`. Once the Gateway has a presence verifier (helper Touch ID, passkeys), a security key (security §10: `permissions.*`, `exec.*`, `vault.*`, `devices.*`, `gateway.*`, `identityLinks.*`, `commands.ownerAllowFrom`, the channel DM / allow policies) fails `approval_required` with `details.approvalId`: a device-only `policy_change` card bound to the key and the value's hash, which needs a presence assertion to approve. The client retries with that `approvalId`; the approval covers that one value, once.
### v1 additive — 2026-10-19 (S02/S05: connector rule and taint sources, #71)

For S02 (`agent-core` passes both), S05 (the broker reads `connectorRule` and fills `taintSources`), S11 / S12 (approval cards show `taint.sources`, security §3.11), S18 (the scenario and injection runners drop their glue).

- New contract type `ConnectorRule` (`{id, action}`): the connector action-matrix key (feature F5, `permissions.connectors[id][action]`). Optional `connectorRule` on `ToolCallIntent` and on `ToolCallDescription` (a tool's `describeCall` declares it; the loop forwards it).
- `ApprovalRequest` (wire) gains optional `taintSources: TaintSource[]` (`{sourceKind, origin?, sender?, toolCallId?}`, security §3.6), present when the request is tainted. `ApprovalRequestInput` gains optional `taintSources`; the broker falls back to `context.taintSources`.
- `FakePermissionBroker` fills `ApprovalRequest.taintSources` from the input or its context.
### v1 additive — 2026-10-20 (S22, issue #169)

- New `browser.realChrome.status` (`operator.read`) → `RealChromeStatus {enabled, attached, port?, pid?, since?, sessions, userDataDir?}`: the composed Gateway's real-Chrome mode (I13) for `psyche security audit` (security §6: the DevTools port is flagged while it runs). No fake: no contract changed.

### v1 additive — 2026-10-19 (S11 M2: quote-reply)

For S11 / S12 (chat column), S01 (session controller). `chat.send` gains optional `replyToMessageId` (feature E5): the message this one answers, in the same thread. The Gateway stores it as `Message.replyToMessageId` (already in the schema) and puts the quoted text ahead of the new message in what the agent sees, so replies carry a quote reference the agent reads.
### v1 additive — 2026-10-19 (S14 M3: VM mode shapes)

For S14 (the mac helper's `vm.*` node capabilities), S11 (Settings → Devices → "Create a sandbox Mac"), S01 (re-broadcasting guest changes).

- New schemas in `schemas/vm.ts` (features L1–L5; spike 06): `VmPhase`, `VmShare`, `VmGuest`, `VmStatus` (the `vm.status` result), `VmCreateParams`, `VmShareAddParams`, `VmProgressEvent` (streamed by `vm.create` / `vm.start`) and `VmUpdatedPayload`.
- New event `vm.updated` (`{nodeId, guest, at}`) for the Gateway to broadcast when a helper reports a guest change.
- No new methods: clients call the helper's `vm.*` capabilities through `nodes.invoke`, so the Permission Broker gates them like any node write; read-write shares need an `approvalId`.

### v1 additive — 2026-10-20 (S11 M2: thread list rows)

For S11 (sidebar rows, UI design §2.2) and S01 (`threads.list`). `ThreadListEntry` gains optional `lastMessage: ThreadPreview` (`role` user | agent, `text` up to 160 characters of plain text, `at`), so the thread list can show each thread's last line without fetching its history.

### v1 additive — 2026-10-19 (S11 M2: quote-reply)

For S11 / S12 (chat column), S01 (session controller). `chat.send` gains optional `replyToMessageId` (feature E5): the message this one answers, in the same thread. The Gateway stores it as `Message.replyToMessageId` (already in the schema) and puts the quoted text ahead of the new message in what the agent sees, so replies carry a quote reference the agent reads.
### v1 additive — 2026-10-19 (S11 M2: backups and logs for Settings)

For S11 (Settings → Data controls and About), S01 / S22 (the Gateway handlers; `psyche backup` and `psyche logs` do the same work locally today).

- New `backup.*` methods (feature U4): `backup.list` (`operator.read`) → `BackupInfo[]` plus the backups directory; `backup.create` (`operator.admin`, side-effecting; `passphrase` sent once, `recipients`, or `unencrypted: true`) writing a consistent snapshot in the `psyche backup` format; `backup.verify` (`operator.admin`) checking every manifest hash; `backup.delete` (`operator.admin`, side-effecting). Restore stays a CLI operation with the Gateway stopped. New schema `BackupInfo` (`file`, `createdAt`, `bytes`, `encrypted`, `verifiedAt`).
- New `logs.tail` (`operator.read`; feature U5): newest matching lines from the Gateway's structured logs (`lines`, minimum `level`, `subsystem`, `since`, `search`) with the subsystems seen and a `truncated` flag. New schemas `LogLevel` and `LogLine` (`ts`, `level`, `subsystem?`, `msg`, `fields?`); lines carry metadata only, never bodies or secrets (architecture §14).
### v1 additive — 2026-10-20 (S11 M2: threads.update, per-thread model context)

For S11 (composer `/model` and `/plan`, the mode and model pills), the composition root (handler), S02 (`agent-core` passes the thread to the model), S03 (the router's per-thread pin).

- New `threads.update` (`threadId`, optional `permissionMode`, optional `modelRef` or `null`; `operator.write`) → `ThreadResult`. `auto` is refused with `forbidden` unless the thread's model is on the auto-mode allowlist (security §7.2, architecture §4.4); picking a model that is not allowed drops an `auto` thread to `balanced`. The shell has called this method since M1 and treats `unknown_method` as unavailable.
- New contract type `ModelCallOptions extends CallOptions` (`threadId?`, `runId?`); `ModelProvider.stream` takes it, so the router can apply a thread's `/model` pin and attribute usage. Providers that ignore the fields need no change. `FakeModelProvider` records them in `callContexts`.

### v1 additive — 2026-10-19 (S08 browser M2: recordings, I10)

For S08 (`packages/browser` recorder), the Gateway composition (handlers) and S12 (the Activity sheet's replay UI).

- New schemas `BrowserRecording`, `BrowserRecordingEvent` (`BrowserRecordingEventKind`: tab, navigation, snapshot, action, fill, download, blocked, control, dialog), `BrowserRecordingFrame`, `BrowserRecordingId`.
- New methods `browser.recordings.list` (paged, by task or thread), `browser.recordings.get` (the replay index: events and frames, `sinceSeq` for a live recording), `browser.recordings.frame` (one screencast frame, base64), `browser.recordings.snapshot` (the snapshot text a `snapshot` event recorded, untrusted) and `browser.recordings.delete` (`operator.write`, side-effecting).
- New event `browser.recording.updated {recording}`.
- No contract or fake change: these are client methods over files the browser package writes.
### v1 additive — 2026-10-19 (S17 M2: voice memos, speech.voices)

For S17 (`packages/speech`), S01 (Gateway routing), S11/S12 (composer memo button, persona voice picker), S10 (channel voice notes).

- `voice.start` gains optional `memo: boolean`: the session keeps its audio.
- New `voice.memo.save {sessionId, threadId?, task?: MemoTaskMode}` → `{transcript, item: LibraryItem, task: Task | null, provenance, content: VoiceMemoContent, blocks: Block[], durationMs}` (`operator.write`, side-effecting): files the session as a Library `recording` with the transcript as text extract and creates a Task when the memo asks for one (`auto` = only on a cue such as "remind me to…"). The transcript is content: `VoiceMemoContent` lists URLs (never fetched) and flags instruction-like phrasing; `blocks` quote it under a label (feature Q4).
- New `speech.voices {personaVoice?}` → `{voices: SpeechVoice[], default, unavailable}`: every synthesis voice as `<engine>:<voice>` for voice selection per persona (feature Q3). `SpeechVoice.nonCommercial` marks Apple Personal Voice.
- New schemas `MemoTaskMode`, `VoiceMemoContent`, `SpeechVoice`.
- Contract `Voice` gains optional `nonCommercial` (the helper's `speech.voices` already reports `personalVoice`). `FakeSpeechEngine` is unchanged (the field is optional).
### v1 additive — 2026-10-20 (S21 sandbox: file provenance, design-07; issue #97)

For S21 (`packages/sandbox`) and the owner of the `exec` / workspace file tools (S01).

- `ExecRequest` gains optional `provenance: ProvenanceOut` and `taintSources: TaintSource[]`: the provenance of what the command writes. Files it creates or changes are recorded with it; absent means `untrusted` (the safe default), so an untainted turn passes `"trusted"`.
- `ExecResult` gains optional `provenance: ProvenanceOut`: `untrusted` when the request was untrusted or `/workspace` holds any untrusted-provenance file. The `exec` tool reports it as the result's provenance so the loop taints the turn.
- `FakeSandboxRunner` mirrors the rule (per-sandbox `untrustedFiles(sandboxId)` from `filesChanged`); no other fake change.

### v1 additive — 2026-10-20 (S05 M2: audit.friction)

- `audit.friction` (`since`, `until`; `operator.read`) returning `AuditFrictionResult` (with `AuditFrictionKind`): approval-friction metrics computed by `@psyche/permissions` `frictionMetrics` from the audit log's decision, approval, grant and classifier entries.
### v1 additive — 2026-10-19 (S02 loop: standing grants, requester, taint persistence)

For S02 (`packages/agent-core`), S05 (`packages/permissions`, PR #89), S09 (`packages/connectors`), S01 (Gateway call context, channels), S04 (`packages/tasks`).

- New schema `TaintSource` (`{sourceKind, origin?, sender?, toolCallId?}`, security §3.6), the shape `@psyche/permissions` already used.
- New `Requester` (`role: owner | designated | allowed`, `identityId`, `display`, `channel`, `senderId`, `chatId`, `links`, `toolAllow`; security §9, S10 `RouteContext`). `DecisionContext` gains optional `requester` and `taintSources`; `ApprovalRequestInput` gains optional `context: DecisionContext` so cards name the person and the taint sources and the requester's own chats are never approval surfaces.
- `StartTurnInput` gains optional `requester`: the loop taints a non-owner's turn, never treats their text as the owner's words, and decides every call as theirs.
- New `ToolCallAuthority` (`rule`, `bindingHash`, `grantKey?`, `approvalId?`, `grantId?`, `scope?`): what authorized a dispatch, as the loop verified it, for executors with their own enforcement (connectors, browser). New helper `namespacedGrantKey(tool, grantKey)`, the loop's grant-key namespacing, so executors can recompute the key a standing grant must match.
- `TaskCreateInput` and `Task` gain optional `taintSources` (S23 design-08): a Task starts every run tainted with its creating turn's sources. `FakeTaskEngine` keeps them; the SQLite engine (S04) does not persist them yet.

### v1 additive — 2026-10-20 (S01 Gateway M2: audit)

- `audit.list` (`kind`, `kindPrefix`, `taskId`, `approvalId`, `since`, `until`, `sinceSeq`, `limit`, `order`; `operator.read`), `audit.verify` (`AuditVerifyResult`; `operator.read`) and `audit.export` (`jsonl` / `json`, time window; `operator.admin`). Shapes and scopes are those of the handlers S05 already ships in `@psyche/permissions`, which the Gateway now mounts.

### v1 additive — 2026-10-19 (S16 search and skills)

For S16 (`packages/search`, `packages/skills`), S01 (dispatch), S02 (skills prompt index), S11/S12 (Search screen, Settings → Skills).

- `SearchScope` gains `ideas`, `goals`, `connectors` (appended).
- `SearchHit` gains optional `kind` (`SearchIndexDocKind`), `group` (new `SearchGroup`), `provenance`, `createdAt` (epoch ms), `snippetHighlights` and `titleHighlights` (new `HighlightRange`, `[start, end)` integer pairs).
- `search.query` result gains optional `groups` (new `SearchHitGroup { group, count, hits }`), `total` and `warnings` (filter tokens that were not understood).
- `SearchIndexDoc` gains optional `scopeKey` (owner or a designated-person session key), `parentId` (collapse target) and `source` (producer id for bulk removal).
- New `skills.*` methods mirroring `SkillsHandlers` in `packages/skills/src/handlers.ts`: reads `skills.list`, `skills.get`, `skills.search`, `skills.commands`, `skills.getProposal` (`operator.read`); mutations `skills.proposeInstall`, `skills.proposeUpdate`, `skills.proposeApproval`, `skills.install`, `skills.setEnabled`, `skills.remove` (`operator.admin`, side-effecting).
- Schemas `SkillDetails`, `SkillStatus`, `SkillProposal`, `SkillProposalFile`, `SkillProposalResult`, `SkillChangeEvent`, and JSON forms of the contract types (`SkillSummarySchema`, `SkillSourceSchema`, `SkillTrustSchema`, `ScanFindingSchema`, `SkillInstallSourceSchema`, `SkillCommandSchema`).
- New event `skills.changed` whose payload is `SkillChangeEvent` (`reloaded` / `hash_mismatch` / `installed` / `removed`).
- `SkillLoader` gains optional `promptIndex(options?)`, `commands()` and `setEnabled(name, enabled, source?)`, with the types `SkillCommand`, `PromptIndex`, `PromptIndexOptions`; `ScanFinding` gains optional `file`. `FakeSkillLoader` implements all three.

### v1 additive — 2026-10-20 (S07 memory, H9)

- New schema `PersonaIdentity` (the `IDENTITY.md` frontmatter fields).
- New methods `memory.persona.get` and `memory.persona.edit` (natural-language `instruction` and/or explicit `fields` / `description`, optional `etag`; returns `changed` and `avatarRequested`).
- New event `persona.updated { identity, changed, avatarRequested }` so the header updates within the turn and the avatar renderer knows when to make a new avatar.

### v1 additive — 2026-10-19 (S17 speech)

For S17 (`packages/speech`), S01 (dispatch), S11/S12 (composer dictation, read-aloud).

- Methods `voice.start` (raw PCM format, language, vocabulary ≤ 64 terms; answers `{sessionId | null, location, engine}`, null + `client` = dictate in the browser), `voice.push` (ordered base64 chunks ≤ 512 000 chars), `voice.stop` (→ `Transcript`), `voice.cancel`, and `speech.readAloud` (side-effecting: writes a Library audio item; → `streamId`).
- Events `voice.segment`, `voice.ended`, `speech.audio`, `speech.readAloud.completed`, `speech.readAloud.failed`.
- Schemas `AudioFormat`, `TranscriptSegment`, `Transcript` (JSON forms of the `SpeechEngine` contract types), `SpeechEngineLocation`, `VoiceEndReason`.

### v1 additive — 2026-10-19 (S06 vault, follow-up)

- `fillElementAccepts`: a password (or a login's primary secret) goes only into `type=password`. The `type=text` + `autocomplete=current-password` exception is gone: a show-password field would put the value on screen. Found by the S06 adversarial review after #12's merged head.

### v1 additive — 2026-10-19 (S04 tasks and scheduler)

- `AutomationKind` gains `reminder` (one-shot; `schedule` is an ISO-8601 instant), so Upcoming (O4) can tell reminders from recurring automations.
- `Automation` gains optional `watch: WatchConfig` (`url`, `check: change | text_present | price_below | price_above`, `selector?`, `text?`, `threshold?`; data model §8 `watches`) and `lightContext` (heartbeat, O2). `automations.create` takes both; `automations.update` takes both plus `scratch` (the per-job scratch note).
- New schemas `AutomationRun` (`AutomationRunStatus`; data model §8 `automation_runs`) and `UpcomingItem`.
- New methods `automations.runs` (history, paged) and `automations.upcoming` (Upcoming view).
- New events `automation.updated`, `automation.run.started`, `automation.run.finished`.
- `FakeScheduler` fires `reminder` once and then clears `nextRunAt`.
### v1 additive — 2026-10-19 (S06 vault)

Additive, for S06 (vault), S08 (browser fill), S09 (connector OAuth), S11/S12 (Settings → Credentials), S01 (dispatch).

- `CredentialBroker.ts`: `FillElement`, `fillElementAccepts()` (field-class rule from S23 design-01: a password only into a password field, never a textarea / contenteditable / search box), `ResolveOptions.element` and `ResolveOptions.selector`. Brokers refuse a browser resolve without `element`.
- `ConnectorCredentialStore` (`store`, `accessToken`, `rotate`, `revoke`, `onRevoked`) and `OAuthTokenSet`, `ConnectorTokenInput`, `CredentialRevokedEvent` for connector-owned OAuth items (G13).
- Schemas: `CredentialUse`, `VaultKeySlot`, `VaultStatus`, `CredentialSecretInput` (client → Gateway only).
- Methods: `vault.status`, `vault.setup`, `vault.confirmRecovery`, `vault.unlock`, `vault.lock`, `vault.add`, `vault.update`, `vault.delete`, `vault.import`, `vault.uses`.
- Events: `vault.locked`, `vault.unlocked`, `credential.updated`.
- `FakeCredentialBroker`: checks `element` for browser resolves, never matches opaque (`"null"`) origins (S23 design-13), implements `ConnectorCredentialStore`. Conformance: a browser-fill element case.
### 2026-10-19 — browser bridge amendments and `view.report` (S11)

Needed by S11 (desktop) and S08 (CDP driver); from `docs/spikes/spike-01-cdp-bridge.md`.

- `BRIDGE_MAX_FRAME_BYTES` (16 MiB) and `parseFrame(raw, { maxBytes })`: raw AX trees exceed 1 MiB. Other transports keep `MAX_FRAME_BYTES`.
- `ErrorCode` gains `user_in_control`, `debugger_detached`, `tab_not_found`, `method_not_allowed`.
- `BridgeTab` gains optional `openerTabId`, `disposition`, `taskId`; `bridge.tab.open` gains optional `taskId`, `taskTitle`.
- New method `bridge.tab.status` (Gateway → desktop): status pill text and the action highlight rectangle (I5).
- `bridge.control.changed` gains optional `via` (`keyboard | mouse | button | release | idle`); new event `bridge.debugger.detached {tabId, reason}`.
- New method `view.report {layout}` (desktop → Gateway) so `view.layout` has something to return.
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
### v1 additive — 2026-10-19 (S01 Gateway core)

- **Security fix, behavior change (needs S00 sign-off):** `isAdminSettingKey` is now an allowlist. Every key needs `operator.admin` unless it is under one of `USER_SETTING_PREFIXES` (`appearance`, `ui`, `editor`, `shortcuts`, `locale`, `notifications.sound`, `notifications.badges`), matched by whole segments, case-insensitively. New export `isUserSettingKey`. `ADMIN_SETTING_ROOTS` stays exported for reference. Fixes S23 review PR-1-C (owner identity, sessions, MCP, connectors, skills, plugins, models, updates, browser, VM, memory and backup keys were writable with `operator.write`).
- `PairingRequest`: optional `publicKeyFingerprint` (`sha256:<hex>` of the raw key), `transport` (`ws | unix`) and `remoteAddress`, so the owner approves a key, not a name (S23 review PR-1-B).
- `devices.approve`: optional `code`; when present it must equal the code shown on the new device.
- `threads.list`: optional `query`, a case-insensitive substring match on titles (feature E1 "search").
- `thread.deleted` event so every client drops a deleted thread (feature N14).
- `chat.queue.list` / `chat.queue.remove`, the `QueuedMessage` schema and the `chat.queue.updated` event: the follow-up queue is visible and removable (feature E3).
- `AgentLoop`: `AgentEvent` `tool_call` gains optional `details: ToolCallDetails` (redacted params, params hash, side effect, target, decision, approval, taint, provenance, receipt) so the Gateway can persist `tool_calls` rows and emit full `tool_call.updated` payloads. Needed by S01; S02 fills it.
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
