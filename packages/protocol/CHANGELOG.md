# @psyche/protocol

## 0.3.0-alpha.0

### Minor Changes

- 428ec1e: `ApprovalKind` gains `apple_script` and `shortcut_run` (J4): scripts and Shortcuts run by the agent on the Mac get their own approval cards, offered `once` only.
- a5cef4e: `attention.report`: the desktop reports pane visibility and owner input for pause-when-unwatched (#272).
- 353afa9: New `devices.bootstrapAdmin {}`: the desktop shell's first admin grant on a fresh Gateway, without a terminal.
- 2558bfe: `files.list`, `files.read` and `documents.convert` for the Files pane and its viewers (P4): read-only, chunked under the frame limit, scoped to granted folders and the Library.
- 7ac975c: `task.start` is a `write` with its own `task_start` approval kind (#48, review design-08): agent-core declares it, the broker infers it and titles the card "Start background task", chat cards say "Start a background task".
- 09c0c6f: Fresh-presence `approvalId` on admin methods that widen access, the `presence_required` error code, and signed-anchor fields on `AuditVerifyResult`.
- d982437: `ToolCallMeta.mcpServerId | mcpToolsListHash | mcpTier` (issues #279, #280).
- c4175a2: `devices.presenceKey.list | register | remove` and `PresenceKeyInfo`: registering a helper's Secure Enclave presence key (issue #253).
- eaf91c6: `models.list`, `models.probe`, `models.check` and `models.setRole` for Settings → Model & providers (B1, B4): configured providers, endpoint probe results with capability guesses, the six-case tool check, and primary/utility role picks.
- 19c1ba5: New `models.setKey {providerId, key}` (operator.admin, side-effecting): stores a hosted provider's API key in the vault as a Gateway-owned item, for first-run onboarding without environment variables.
- 4f74993: P9 file tools get a package (#49): `@psyche/files` ships `read_file`, `write_file`, `edit_file`, `list_dir` and `search_files` with symlink, traversal and granted-folder refusal, size caps and paging, atomic writes, exact-match edits with conflict detection, and write provenance. `ToolCallDescription` gains optional display-only `details`, which the agent loop puts on the approval card (the `file_write` card's diff). The Gateway registers the package in place of INT-1's stand-in.
- 5e605af: Additive: `StartTurnInput.beforeDispatch` write-ahead hook and the `DispatchIntent` type (#63); `FakeAgentLoop` awaits it before a scripted dispatch.
- 8a8dacb: Additive: `ConnectorRule` on `ToolCallIntent` / `ToolCallDescription`, and `taintSources` on the `ApprovalRequest` wire schema and `ApprovalRequestInput` (#71).
- 310ac67: `backup.list`, `backup.create`, `backup.verify`, `backup.delete` and `logs.tail` methods with the `BackupInfo`, `LogLevel` and `LogLine` schemas (Settings backups and log viewer, U4 / U5).
- 2f63bac: `chat.send` gains optional `replyToMessageId` (quote-reply, E5).
- dc190a6: `ThreadListEntry.lastMessage` (`ThreadPreview`: role, text, at) for the thread list's last line.
- 5d2cbeb: `threads.update` (permission mode and per-thread model) and `ModelCallOptions` (`threadId`, `runId`) on `ModelProvider.stream`; `FakeModelProvider.callContexts`.
- 0899f3b: Search scopes `ideas`, `goals`, `connectors` and optional hit fields (kind, group, provenance, highlights) with grouped results; `skills.*` methods and the `skills.changed` event; optional `SkillLoader.promptIndex`, `commands` and `setEnabled`, implemented by `FakeSkillLoader`.
- 08664c3: `voice.start.memo`, `voice.memo.save` (voice memos → Library recording + optional Task, transcript as content) and `speech.voices` (every synthesis voice as `<engine>:<voice>` for persona voice selection); `Voice.nonCommercial`.
- e54d672: Add `dictation.target`, `dictation.insert`, `dictation.watch` and the `dictation.key` event for system-wide dictation (J9, Q2).
- 3461262: `ToolSpec.descriptionProvenance` (optional): who wrote a tool's description and schema text; `FakeMcpHost` sets it from the trust tier (#281).
- 8a9ee2c: Protocol: `vault.linkExternal`, `vault.payments.list`, `vault.payments.methods`, event `vault.payment.updated`, optional `CredentialMeta.backend`. Vault: the handlers for them (payments through an optional `PaymentBroker`), `PaymentBroker.list / methods / onUpdate`, `backend` on listed items.
- f80b0ec: Vault methods and events, `FillElement` field-class check on browser resolves, and `ConnectorCredentialStore` for connector-owned OAuth tokens.
- 75a0f80: Web passkeys (WebAuthn) for the server-mode web client: `passkeys.*` methods, `ApprovalAnswer.presence`, a per-device passkey store, and a `webauthn` presence verifier that counts toward the security-settings presence check once a passkey is registered.
- 2e9c025: `audit.list`, `audit.verify` and `audit.export` methods (shapes from the `@psyche/permissions` handlers).
- e4c109b: Admin settings become an allowlist (`USER_SETTING_PREFIXES`); `PairingRequest` gains the key fingerprint, transport and remote address; `devices.approve` takes an optional `code`; `threads.list` takes an optional title `query`; `chat.queue.list` / `chat.queue.remove` and `chat.queue.updated` expose the follow-up queue; a `thread.deleted` event; `AgentEvent` `tool_call` carries optional `details`.
- 5dcf208: Standing grants reach connector executors: the loop puts what authorized a dispatch (approval or standing grant, binding hash, scope) on `ToolRunContext.authority`, and the connector registry confirms a grant the way it confirms an approval. The sender of a channel turn travels as `StartTurnInput.requester` into `PermissionBroker.decide` and the approval card's context. Taint persists across kill/restart: `tool_call` events carry the persisted details, thread state keeps the taint sources, and tasks carry `taintSources`.
- c840e75: protocol: `AgentLoop.explainContext` with `ContextSection` / `ContextExplanation` (C11), `ToolRegistration.describeCall` with `ToolCallDescription` (security §3.5), and `MemoryStore.flush` for the pre-compaction flush (B7). Fakes implement all three.
- 2607fc3: Scheduler: `reminder` automation kind, watch config and `lightContext` on automations, `AutomationRun` and `UpcomingItem` schemas, `automations.runs` / `automations.upcoming` methods, `automation.updated` / `automation.run.started` / `automation.run.finished` events.
- 4bc7113: Approval-friction metrics from the audit log: `frictionMetrics` in `@psyche/permissions` and the `audit.friction` method (`AuditFrictionResult`, `operator.read`) in the protocol.
- 515b904: Security settings need fresh presence once a presence verifier exists (security §10): `settings.set` on a security key returns `approval_required` with a device-only, presence-gated `policy_change` card, and goes through when retried with the approved `approvalId`.
- f4cf9c0: Memory: AGENTS.md is protected; memory.* methods for the Soul & Memory sheet (files, daily notes, claims, explain, forget, remember, import, export, reset, status, pause); etag on memory.read/write; memory.file.changed and memory.job.updated events.
- e0d2f7e: Persona (H9): PersonaIdentity schema, memory.persona.get / memory.persona.edit methods, persona.updated event.
- 95f1980: Channels (S10): optional `ChannelAdapter` fields and methods (identity strength, forwarded/quoted/edit markers, attachment kind/ref, typing, fetchAttachment, health), `ChannelIdentity`, `channels.configure`, `channels.allowlist.update`, `channels.pairing.*`, `channels.identities.*` methods and the `channels.updated` event.
- 2b2e906: Browser bridge: 16 MiB frame cap, bridge error codes, popup and task metadata on tabs, `bridge.tab.status`, `bridge.debugger.detached`, control `via`; `view.report` for the desktop's pane layout.
- 13afc8a: Add the methods and events the UI needs to answer questions, look up receipts and artifacts, and drive the Feed, Ideas and Goals screens, plus the caller's own approval answer token.
- 1331bfc: Typed shapes for the mac helper's Apple app adapters (J6): Calendar and Reminders (EventKit), Mail, Notes, Finder and Safari.
- 04be9ec: VM mode M3 shapes: paused / saved phases, guest display, clipboard (existing VmClipboardMode) and vault placement, guest agent status, file transfers, `vm.configure` / `vm.copy_in` / `vm.copy_out` params (S14, L1–L5).
- 2525712: VM mode shapes for the mac helper's `vm.*` capabilities (`VmGuest`, `VmStatus`, `VmShare`, `VmCreateParams`, `VmShareAddParams`, `VmProgressEvent`) and a `vm.updated` event (S14, L1–L5).
- e7c3564: Add `notification.updated` / `notification.resolved` events, optional `Notification.staleAt` / `staleReason`, and optional `NotificationAction.authenticationRequired`.
- a549b95: Extend S12's proactive methods additively: `feed.generate`, `goals.create` / `update` / `archive` / `milestone` / `link`, optional `feed.feedback.ledgerChanges`, `ideas.accept` schedule fields, `goals.get` milestones and links, `GoalMilestone` / `GoalLink` schemas, and the `feed.updated` event.
- 75d2aa9: `voice.*` dictation methods and events, and `speech.readAloud` with its audio and completion events.
- 420ab8e: `psyche security audit` covers every check in security §10: egress proxy, MCP sandboxing and unknown-tier servers with network, computer-use overrides, real-Chrome mode and consent, backup encryption and age, update manifest verification, token age and version. New `mcp.status`; `sandbox.status` is served and reports the egress proxy.
- 206f295: `psyche security audit` flags real-Chrome mode while it is attached (port, PID, profile dir), from the new `browser.realChrome.status` method.
- e99009a: Skills install and trust (T2): `SkillManifest`, `SkillUpdateStatus`, `skills.checkUpdates`, the `skills.updated` event, and a dedicated device-only `skill_install` binding covering source, tree hash and the declared tools, approval kinds and prompt files.
- 38f71de: Taint hand-offs from S02's loop-grants work: `Task.taintSources` is persisted in SQLite (design-08, #96), and the sandbox keeps file-level provenance on workspace files and exec results (`ExecRequest.provenance` / `taintSources`, `ExecResult.provenance`; design-07, #97).
- 952c222: `ToolCallDescription` and `ToolCallIntent` gain an optional `meta: ToolCallMeta {app?, action?}`, so the Permission Broker's per-app tier check can key on the computer-use action instead of the tool name.
- ee4c781: `StartTurnInput.taintSources`: untrusted content inside a turn's input (forwarded or quoted third-party text in an owner's channel message) starts the turn tainted (#275).
- 0c71158: `ApprovalKind` gains `git_write` and `git_push` (V10 coding helper; a push is offered `once` only), and `SandboxRunner.ensureSandbox` takes optional `mounts` (bind mounts of granted host folders, fixed per scope).
- 4b3f571: VM mode, Gateway side (L1–L5): a Task can name its workspace (`sandbox | vm`), `SandboxBackendKind` gains `vm`, and `VM_SETTING_KEYS` / `VmSettings` type the owner's VM-mode settings.

### Patch Changes

- 4f8dff6: `channels.secrets.set` / `channels.secrets.status`: channel transport secrets as Gateway-owned vault items (N8, N9).
- 493b4a5: `messages.*` node capability schemas (J7 / N5): chats, messages after a chat.db cursor, send through Messages.app, a streaming watcher; plus `FakeMessagesNode`.
- 6665567: Browser recordings (I10): `BrowserRecording`, `BrowserRecordingEvent`, `BrowserRecordingFrame` schemas, the `browser.recordings.list | get | frame | snapshot | delete` methods and the `browser.recording.updated` event, for the Activity sheet's replay.
