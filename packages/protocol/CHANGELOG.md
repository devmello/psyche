# @psyche/protocol

## Unreleased (pre-0.3.0)

### Minor Changes

- `plugins.*` methods and schemas for T4 code plugins: list, getProposal, proposeInstall, install, setEnabled, remove; installs reuse the device-only `skill_install` approval (`details.kind: "plugin"`).
- `RelatedThreadsBlock` (`related_threads`): the owner's other chats a turn drew on (E12), shown as a collapsible "From your other chats" block.
- VM snapshots and resets (L6): `VmSnapshot`, snapshot / restore / reset / delete params and results, `vm.snapshot` / `vm.reset` progress events, `vm.resetPerTask` setting (S14).
- `vm.snapshots.*`: Gateway methods for the sandbox Mac's snapshots, restores and "fresh Mac" resets (L6).
- Prebuilt guest images (L7): `VmImageManifest`, `VmImageFile`, `vm.export_image` params / result, `image` / `imageSha256` on `VmCreateParams`, `vm.import` / `vm.export` progress events (S14).
- Context usage and limits per thread: `threads.contextUsage`, `threads.setContextLimits`, `threads.compact`, the `thread.context.updated` event and the `compaction` block.
- Custom connectors (M9): `CustomConnectorManifest`, `CustomConnectorProposal` and `connectors.proposeCustom | getCustomProposal | installCustom | removeCustom`, installed through the device-only `skill_install` trust card with `details.kind: "connector"`.
- Teach mode (J8): `TeachStep`, `TeachTarget`, `TeachDraft`, `TeachStartParams`, `TeachSessionParams`, `TeachStepEvent` (S14).
- Web Bot Auth (I14): optional `CredentialBroker.botAuthKey()` / `rotateBotAuthKey()`, `BotAuthStatus`, and the `browser.botAuth.status | rotate` methods; the fake broker signs with a real Ed25519 key.
- Voice mode (Q5): `speech.readAloud` takes `save: false` to stream a reply without filing a Library item, and `speech.readAloud.cancel` stops a stream for barge-in.
- Agent-proposed skills (T3): `SkillDraft` and friends, `skills.drafts.list|update|accept|dismiss`, and the `skills.draft.updated` event.
- `connectors.catalogue | connect | disconnect | status | setMatrix` and the `connectors.updated` event; `connect` returns the pending OAuth consent page at once (#505).
- `LearnedFact`, the `learned` block and `memory.forgetLearned` (#509): facts about the owner learned from their own words, shown in the chat with Undo.
- `mcp.probe` / `mcp.add` / `mcp.remove` and `McpServerInput`, `McpProposal`: add an MCP server from Settings behind a sandboxed probe and a trust card (#529).
- `chat.greet {threadId}`: starts the agent's first message in an empty thread, so the main chat opens with the agent's greeting after onboarding (#555).
- New method `usage.summary` (operator.read) and the `Usage*` schemas: tokens, cost and turns from the run ledger by day and model, the month so far, the monthly budget setting and a plan window when an adapter can read one (#599).
- Apple Mail search: optional query plus unread, since / until and from filters, evaluated inside Mail, newest first (#626).
- Stream reasoning steps as `chat.reasoning` (#632): the loop turns the model router's reasoning deltas into redacted, transient steps (setting `agent.showReasoning`, default on) and the Gateway publishes them without persisting them.
- Apple app capability shapes, wave 1 (#637): Mail actions, Reminders and Calendar additions, Notes search/append/update, Contacts, Music, Safari/Chrome tab text, Files, Shortcuts and Things 3.
- People and projects graph (#650): graph schemas, memory.entities.* / memory.loops.* / memory.graph.status methods, memory.entity.updated / memory.loop.updated / memory.suggestion.created events, and person / project search kinds.
- `connectors.configure`: merge non-secret settings into a connector's config without reconnecting it (#640).
- Teaching loop: feedback events, lessons and growth (feedback.*, memory.lessons.*, growth.summary), the taught block, and optional lessonsApplied / redo / FeedPost.growth / ApprovalRequest.fromLesson fields (#678).
- Mail and meeting workflow shapes (#670 W1): batch proposals and the `batch` approval kind, event triggers for automations, `FeedPost.kind` / `refs` / `card`, digest (with the graph's loops), meeting-prep and meeting-notes records, `proposals.*` methods and the `proposal.updated` event.
- Run trace T1 (#660): `RunStep`, the new `Run` fields, `runs.*`, the `run.step` event and the `psyche-trace+json` v1 export recipe; in the UI kit, the run store cases, `data/runs.ts` hooks, `fixtures/runs.ts` and MockGateway `runs.*`.
- Background specialists (#682): `SpecialistSpec` on tasks, `SpecialistResult`, roles and jobs, `specialists.list` / `specialists.jobs`, `tasks.steer` / `tasks.update`, the `specialist.*` events, the `specialist_result` notification kind, `Automation.specialist` and the `subagent` agent event.
- `speech.transcribe_file` params, result and `speech.progress` event, and `calendar.watch` / `calendar.changed` shapes (#673).
- Voice conversation contract (V-G #691): `voice.conversation.*` methods and events, `via: "voice"` on approval answers and messages, `StartTurnInput.voice`, a `voice` model role (falls back to primary), a two-key `dictation.watch`, and the helper's speech shapes for V-H.
- `NotifyInput.breakQuietHours` (optional): one notification may break through quiet hours (meeting prep for a meeting inside them, #670 W6).
- Background specialists, part 2a (#683): a dedicated specialist pool (`specialists.maxConcurrent`, default 3, at most 2 per parent thread) with queue positions; the chat pool no longer claims specialist jobs; `ClaimOptions` origin and per-parent filters; the spawn pre-flight stored on `SpecialistSpec` and returned on `SpecialistJob`.
- Background specialists, part 2b (#683): per-job budget accounting with an 80% marker; at a limit an attended job pauses on a "Budget" question (finish, give it more, stop) and an unattended one writes its partial report; deadlines; the tool-free wrap-up turn; plan-first jobs; `raiseSpecialistBudget` for `tasks.update`.
- Canvas artifacts: `artifacts.create/update/read/versions/restore/list`, patch ops, `ArtifactRef`, `ArtifactVersion` and the `artifact.updated` event (chat experience phase 2).
- New `specialist_result` block: a specialist job's result in the thread that spawned it (chat experience).
- Remove the text-to-speech surface from the protocol: `speech.readAloud*`, `speech.voices`, all `voice.conversation.*` methods and events, `speech.audio` and the read-aloud events, the helper's synthesis schemas and the `voice` model role. Dictation, voice memos and the two-key watch stay.
- Chart, diagram and diff artifact types, the `ArtifactChart` spec and the chart `patch` op (chat experience phase 5).
- New read-only method `insights.summary` (operator.read) for the Overview screen: run, approval, artifact and specialist totals for 7 days, 30 days or all time with the previous period, one row per day in the caller's time zone, and the people and projects Psyche dealt with most. Incognito threads are left out. The UI gets `useInsights(window)` and mock fixtures for a new user, a typical month and a heavy year.
- `insights.summary` totals now carry `runsByKind` (done and failed runs per kind: task, chat, automation, subagent). The Overview's first Summary tile is "Tasks done" (finished task and chat runs, linking to Recent runs filtered to done), and the Automations tile's success rate counts automation runs only. The Recent runs link gains a `status=done` modifier.
- Map artifact type, the `ArtifactMap` spec and the marker ops (chat map widget).
- Attach files in the chat composer. A + button shows when the thread's model can take files (from `models.list`; unknown shows it, a model without vision is offered documents only and says why an image was refused, an embeddings model hides it). Picked, dropped or pasted files become removable chips that upload through the new chunked `library.upload` (25 MiB, origin `upload`), and their Library ids go in `chat.send` `attachments`. The Gateway gives the agent images as image parts (4 per message, 5 MB each) and PDF, DOCX, XLSX and text files as capped extracted text (32k characters each, 96k per message) in the new `TurnInput.attachmentText`, kept out of what the owner said.
- "Ask about this" on each Feed item. It starts a new chat named for the article with the item as a removable chip in the composer (the input asks "Ask about this article…"). `chat.send` takes an optional `context: { kind: "feed_item", id }`; the Gateway reads the item itself and gives the agent its title, source URL, summary, sources and id ahead of the question, as untrusted content (a fenced `<feed_item_context>` preamble, and the turn starts tainted with a `feed` source), never in the system section. The user message records a new `context` block, shown as a compact quoted card in the transcript.
- MCP servers from an exact official source (`@modelcontextprotocol/server-*`, listed vendor packages and vendor endpoints) are `verified` instead of `unverified`. The Gateway derives the tier (`mcpTrustFor`) when a server is added and each time `mcp.servers` is read; owner-edited commands stay `unknown`.
- A connected MCP server's detail now does something: list its tools and switch single tools off for the agent, turn the server off without removing it, see its secrets by name (set or not set) and replace them through the vault, and paste a `mcpServers` JSON config into the Add form (keys go to the vault). New methods `mcp.tools`, `mcp.tools.set`, `mcp.setEnabled`, `mcp.secrets`, `mcp.secrets.replace`; `McpServerStatus.enabled`.

### Patch Changes

- `ChannelSecretName` gains `access_token`, `app_secret`, `verify_token` for the WhatsApp Cloud API channel (N6).
- `authToken?` on `ThingsUpdateParams` and `ThingsCompleteParams` (filled in by the Gateway from the vault, #719).
- The teaching loop's store and routing (#679): feedback events and lessons in the Gateway database, the lesson router with deterministic refusals and one destination per lesson, writers for SOUL.md, AGENTS.md, USER.md, the people graph, skills' LESSONS.md and automations, `feedback.*` and `memory.lessons.*` in the Gateway, approval answers as implicit evidence, and nightly dreaming scheduled at compose time.
- Run trace T1, part 3 (#660): task, automation and specialist turns are recorded through the run-trace sink (`TaskWorkerPoolOptions.trace`); automation runs name their agent run and usage; memory writes name their run and step; computer-use screenshots become run frames.
- Ask about my screen: `screen.capture` / `screen.discard`, the helper's `screen.context` types and `chat.send.screen`.
- Post-meeting notes and Record meeting: `meetings.notes.create`, `meetings.record.{status,start,stop}` and the `meetings.recording.updated` event.
- Record meeting captured by the owner's device: `meetings.record.push` and `reason` on `meetings.record.stop`.
- One table of defaults for the mail and meeting settings (`MAIL_MEETING_SETTING_DEFAULTS`), read by Settings → Mail & meetings; and the batch card's strings in all ten locales.
- Remove all text-to-speech from the Gateway side: synthesis in `@psyche/speech` (Kokoro, ElevenLabs, read-aloud, voice catalog, the voice conversation manager), the voice-turn prompt section and `StartTurnInput.voice`, channel voice-note sending, and the synthesis half of the `SpeechEngine` contract. Speech to text is unchanged. The Gateway removes the stale voice and synthesis settings on start (`deleteSettings` in `@psyche/db`).

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
