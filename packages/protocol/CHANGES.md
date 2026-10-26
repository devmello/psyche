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

### v1 additive — 2026-10-26 (S02, #683 part 2b: budgets and plan first)

- `SpecialistSpec.budgetPause?` (`{inputRequestId, reason, raised?}`, nullable): the job is paused on its budget question. `raised` means `tasks.update` raised the limits.
- `SpecialistSpec.planApproved?`: a plan-first job's plan was approved. No new enum values.
### v1 additive — 2026-10-26 (W, #670: post-meeting notes and Record meeting, docs/workflows/mail-and-meetings-2026.md §4.6)

- **New `meetings.*` methods:** `meetings.notes.create {libraryItemId, startedAt?, title?, speakers?}` → `MeetingNotesResult {status: done | needs_permission, postId?, notes?, remindersProposalId?, question?}` (`operator.write`); `meetings.record.status {}` → `MeetingRecordingStatus` (`operator.read`); `meetings.record.start {consentConfirmed, meetingId?}` and `meetings.record.stop {}` → `MeetingRecordingStatus` (`operator.write`). A start without `consentConfirmed: true` is refused.
- New event `meetings.recording.updated` (payload `MeetingRecordingStatus`).
- New types `RecordingSpeakers`, `MeetingNotesResult`, `MeetingRecordingEnded`, `MeetingRecordingStatus {available, recording, consentLine, startedAt, meetingId, last?}`.

### v1 additive — 2026-10-26 (screen-ask: Ask about my screen, docs/design/screen-ask-2026.md)

- **New `screen.*` methods** (desktop shell only, `operator.write`): `screen.capture {mode: window | region, rect?, maxWidth?, maxHeight?}` → `ScreenCapture {captureId, libraryItemId, thumbnail, width, height, mode, context, refusal?, expiresAt}`; `screen.discard {captureId}` → `{discarded}`. An unsent capture expires after `SCREEN_CAPTURE_TTL_MS` (10 min).
- Helper capability `screen.context` takes `ScreenContextParams` and returns `ScreenContextResult {image (base64 JPEG) | null, width, height, context, refusal?}`; never reachable through `nodes.invoke` or agent tools.
- New types `ScreenContext {appName, bundleId, windowTitle, selectedText, url}`, `ScreenRect`, `ScreenCaptureMode`, `ScreenCaptureRefusal`, `ScreenImageChoice`, `ChatScreenRef`.
- `chat.send` gains optional `screen: ChatScreenRef {captureId, image: auto | pinned | dropped}`.
- Contract `TurnInput.images?` (`{mime, data}[]`, base64): images the model sees with the message (a pinned capture). TypeScript-only; no schema change.

### v1 additive — 2026-10-26 (S02, #683 part 2a: the specialist pool)

- `ClaimOptions` gains `origins?`, `excludeOrigins?` and `perParentLimit?` (the chat pool excludes `subagent` jobs; the specialist pool claims only them, at most N running per parent thread). `FakeTaskEngine.claim` honours them.
- `SpecialistSpec.preflight?` and `SpecialistJob.preflight?` (`ApprovalHint[]`): the spawn's pre-flight, stored on the job so cards and the spawn line read it directly. No new enum values.
### v1 additive — 2026-10-26 (S01, #660: run trace T1, part 3)

- Contract `MemoryWriteOptions.trace` and `DailyNoteInput.trace` (`MemoryWriteTrace {runId, toolCallId}`): the tool call behind a memory write, so `memory.file.changed` can name its run and step. TypeScript-only; no schema change.

### v1 additive — 2026-10-26 (S15, #670 W6: meeting prep)

- `NotifyInput` gains optional `breakQuietHours`: deliver this one notification through quiet hours. Meeting prep sets it when the meeting itself falls inside quiet hours (§4.5 acceptance 3); otherwise only the kinds in `quietHours.breakthrough` interrupt, as before. A TypeScript contract field only; no generated files change.
### v1 additive — 2026-10-25 (S17: voice conversation, V-G #691)

For S17 (`packages/speech` `VoiceConversation`, V-G), S14 (helper, V-H #692), the UI session (V-U #693), S02 (agent-core voice turns), S03 (router). Contract of docs/voice/voice-mode-2026.md §7.

- **New `voice.conversation.*` methods** (all `operator.write`, none idempotency-keyed):
  - `start {threadId?, mode: push | tap | handsfree, format, language?, voice?}` → `{conversationId, engine, location}`;
  - `audio {conversationId, seq, audio}`;
  - `turn {conversationId, action: begin | end}`;
  - `interrupt {conversationId, stage: suspect | confirmed, playedMs?}`;
  - `played {conversationId, utteranceId, playedMs, done}`;
  - `stop {conversationId}`.
  Schemas `VoiceConversationMode`, `VoiceConversationPhase`, `VoiceConversationEndReason`, `VoiceConversationReason`, `VoiceSpeakLevel`, `VoiceNarrateLevel`, `VoiceApprovalTier`, `VoiceTurnAction`, `VoiceInterruptStage`, and `VOICE_CONVERSATION_SETTING_KEYS` (14 `voice.conversation.*` keys).
- **New events** to the starting device only: `voice.conversation.state` (`phase`, `reason?`, `approvalId?`, `prompt?`, `windowMs?`, `listening`), `.caption`, `.speech` (PCM), `.step` and `.ended`.
- **New `InputVia` (`"voice"`)**, used as optional `ApprovalAnswer.via` (answered by a spoken phrase after a readback; chat's tiers, never `deviceOnly`) and optional `Message.via` (spoken by the owner).
- **Contract `StartTurnInput.voice?: VoiceTurnOptions`** (`speak`, `narrate`, `language?`): the loop adds the voice-turn prompt section and runs with thinking off where the model allows. Fakes need no change.
- **`PickableModelRole` and `ModelRoles` gain `voice`** (the chat model for voice turns). Outside the protocol, as allowed for new enum values: the router's `MODEL_ROLES` gains `voice`, which falls back to the primary chain like `utility` and `vision`; the Gateway's `ROLE_SETTING` gains `models.voice`, and its role restore and `roles()` include it.
- **`dictation.watch`** takes optional `keys: [{key, role: dictation | voice}]` (≤ 2); `DictationKeyPayload.role?` (`DictationKeyRole`). The single `key` form is unchanged.
- **New `schemas/speech-conversation.ts`** with the helper's speech shapes for V-H: `HelperSpeechVoice` (`quality`, `personalVoice`, `installed?`), `HelperSynthesizeParams` (`speed?` 0.5–2, `utteranceId?`), `speech.prepare` params and result, `SpeechTranscribePreset` (`long | short`), `PersonalVoiceAuthorization` and `HelperSpeechTimings`. These describe helper capabilities and register no client methods.
- **Swift.** Every new enum has an `$id` except `voice.conversation.caption.role`. Its values equal custom connectors' `drafted`, and quicktype merges enums with equal values, so an id would rename that Swift enum. The generated Swift changes only by additions plus five initializers that gained an optional trailing parameter (`ApprovalAnswer`, `Message`, `DictationKeyPayload`, `DictationWatchParams`, `ModelRoles`). The helper's two `DictationKeyPayload` sites pass `role: nil`, and `swift build --target PsycheHelperSystem` passes.

### v1 additive — 2026-10-25 (T1, #679: teaching loop store and routing)

- `ApprovalRequestInput` gains optional `fromLesson { lessonId, feedbackId, because }`, copied by the broker to `ApprovalRequest.fromLesson` (added in #678) so a lesson's card can show "Because you said: …". `FakePermissionBroker` copies it too.
### v1 additive — 2026-10-25 (S15, #670 W1: mail and meeting workflows)

For S15 (W, #670), the skills (S, #671), the UI (U, #672) and the helper (H, #673): the shapes of docs/workflows/mail-and-meetings-2026.md. All new fields are optional, new enum values are appended, and new schemas are new names.

- New `schemas/workflows.ts`: `ActionCall`, `ActionProposal` (+ `ActionProposalStatus`, `ActionCallResult`), `AutomationTrigger` (+ `WorkflowEventSource`, `WorkflowEventFilter`), `WorkflowEvent`, `MailThreadRef`, `DigestCategory`, `DigestAction`, `DigestItem`, `DigestGroup`, `DigestLoop` (a graph `GraphLoop` with the digest's `shownCount`), `InboxDigest`, `SourcedLine`, `MeetingAttendee`, `MeetingPrep`, `MeetingActionItem`, `MeetingNotes`, `WorkflowCard`, `FeedPostKind`, `FeedPostRefs`.
- `ApprovalKind` gains `batch` (one approval bound to the ordered calls of a proposal, write-only, once). `packages/channels` gets its label.
- `AutomationKind` gains `event`; `Automation.trigger`; `AutomationRun.trigger` gains `event`; `AutomationRun.events`; `UpcomingItem.trigger` / `lastRunAt`.
- `FeedPost.kind`, `FeedPost.refs`, `FeedPost.card`.
- New methods `proposals.list | get | approve | dismiss | undo`; new event `proposal.updated`. Follow-ups use the memory graph's loops (`GraphLoop`, `memory.loops.*`, #650), not a second store.
### v1 additive — 2026-10-25 (S14, #673 H: long-form transcription and calendar.changed)

For W6 (#670) and the helper's H1 / H2, docs/workflows/mail-and-meetings-2026.md §8.4. All new names.

- `schemas/speech.ts`: `SpeechTranscribeFileParams {path, locale?, vocabulary?, maxDurationMs?}` (≤ `SPEECH_FILE_MAX_DURATION_MS`, 4 h), `SpeechTranscribeFileResult {text, segments, engine, language, audioMs, chunks}`, `SpeechNodeEngine`, the streamed `SpeechProgressEvent` (`speech.progress`) and `SPEECH_FILE_CAPABILITIES`.
- `schemas/apple-apps.ts`: `AppleCalendarWatchParams` and `AppleCalendarChangedEvent` (`calendar.changed {at, coalesced}`), streamed by the helper's `calendar.watch`. A node event is tied to an invocation, so the Gateway holds one `calendar.watch` open, as it does `messages.watch`.
### v1 additive — 2026-10-26 (U, #640: connector settings from Settings → Connectors)

For the UI session (U) and S09 (G, #639): `connectors.configure {connectorId, config}` merges non-secret keys into a connector's `config` (`null` removes one) without reconnecting it. Settings writes `apple:shortcuts`' `config.shortcutRules` (`off` / `ask` / `allow` per shortcut id) and Obsidian's `config.vaultPath` and `config.dailyFolder` through it. G implements the handler.
### v1 additive — 2026-10-26 (S09 for S14 #719: Things auth token)

- `ThingsUpdateParams.authToken?` and `ThingsCompleteParams.authToken?`: Things' URL-scheme auth token, which the Gateway fills in from the vault for that call only. The model never writes it, no card shows it, and the helper neither logs nor stores it.

### v1 additive — 2026-10-25 (E, #678: the teaching loop)

For T1 (#679), T2 (#680) and T3 (#681), docs/agent/teaching-loop-2026.md §3 and §7. All new fields are optional and all new schemas are new names.

- Schemas (`schemas/learning.ts`): `FeedbackKind`, `FeedbackTarget`, `FeedbackReason`, `FeedbackScope`, `FeedbackEvent`, `LessonKind`, `LessonOrigin`, `LessonStatus`, `LessonScope`, `LessonDestination`, `Lesson`, `LessonRef`, `GrowthWindow`, `GrowthMetric`, `Milestone`, `GrowthItem`, `GrowthSummary`, `GrowthCardItem`, `GrowthCard`, `TeachingImplicitSignals`, and `TEACHING_SETTING_DEFAULTS` for the keys `teaching.enabled`, `teaching.implicit`, `teaching.surfaces`, `teaching.paused`, `teaching.weeklyCard`.
- Methods: `feedback.give / list / delete`, `memory.lessons.list / get / confirm / edit / forget / forgetAll` (forgetAll presence-gated, operator.admin), `growth.summary`.
- Events: `feedback.recorded`, `lesson.changed`, `growth.updated`.
- Block `taught` ("Psyche will remember: …").
- Optional fields: `Message.lessonsApplied`, `Task.lessonsApplied`, `FeedPost.growth` (the weekly card), `chat.send` `redo { messageId, instruction?, withoutLessons? }`, `ApprovalRequest.fromLesson { lessonId, feedbackId, because }`.
### v1 additive — 2026-10-25 (S01, #660: run trace T1)

For T2 (#661), T3 (#662) and S02's specialists: the step model of docs/design/run-trace-2026.md §4. Everything is optional or new; old clients ignore `run.step`.

- `RunStep` (`schemas/runs.ts`) with `RunStepKind`, `RunStepStatus`, `RunStepError`, `RunStepAttempt` and `RUN_STEP_LIMITS`; `RunSummary` (Run fields + `currentStep`, `activity` (12 buckets), `durationsMs`); `RunFrame`; `RunTraceFormat`.
- `Run` gains `kind` (`RunKind`), `origin` (`RunOrigin`), `title`, `parentRunId`, `rootRunId`, `taskId`, `automationRunId`, `stepCount`, `currentStepId`, `lastStepAt`, `budget` (`RunBudget`, the shape S02's specialists use), `deadline`, `specialist {role}`, `note`. These are the shared Run fields S02's specialists protocol reuses.
- `ToolCall.stepId`; `AutomationRun.runId` and `usage`; `BrowserRecording.runId`; `memory.file.changed` gains `runId` and `stepId`.
- Methods `runs.get | steps | list | children | step | frames | frame | export` (`operator.read`) and `runs.delete` (`operator.write`, side-effecting).
- Event `run.step {runId, step}`: an upsert per change, never carrying thinking text or payload bodies.
- `psyche-trace+json` v1 (`PsycheTrace`, `TraceStep`, `TraceRun`, `TraceChild`) and the shared recipe `buildPsycheTrace` / `traceMarkdown` / `traceAttributes` (OTel GenAI attribute names), used by the Gateway's `runs.export` and the MockGateway.

### v1 additive — 2026-10-25 (S07 memory: people and projects graph, #650)

- New schemas in `schemas/graph.ts` (docs/memory/people-and-projects-2026.md §4, §6.1): `GraphEntityKind`, `GraphEntityStatus`, `GraphProjectStatus`, `GraphIdentifierKind`, `GraphIdentifier`, `GraphFactAttribute` (allowlist; no sensitive traits), `GraphRelationshipLabel`, `GraphWriteSource`, `GraphFact` (provenance, evidence, validity, supersession), `GraphEdgeRel`, `GraphEdge`, `GraphInteractionKind`, `GraphParticipantRole`, `GraphInteraction` (headers and links, no bodies), `GraphLoopStatus`, `GraphLoop`, `GraphEntity`, `EntitySummary`, `GraphEntityDetail`, `GraphSuggestion`, `GraphSource`, `GraphStatus`.
- New methods: `memory.entities.search | get | interactions | create | update | facts.set | facts.retract | edges.set | edges.retract | history | merge | split | suggestions | suggestions.answer | forget` (`forget` is `operator.admin`), `memory.loops.list | update`, `memory.graph.status`.
- New events: `memory.entity.updated`, `memory.loop.updated`, `memory.suggestion.created`.
- `SearchIndexDocKind` gains `person` and `project`; `SearchScope` and `SearchGroup` gain `people` and `projects` (the search package and the Search screen's exhaustive maps get matching entries).
### v1 additive — 2026-10-26 (S02, #682: background specialists)

Depends on the run-trace T1 additions (#660), which carry the shared `Run` fields (`kind`, `origin`, `parentRunId`, `rootRunId`, `taskId`, `budget: RunBudget`, `deadline`, `specialist {role}`), `RunSummary` and `runs.children`.

- `schemas/specialists.ts`: `SpecialistSpec` (the `Task.specialist` block: role, parent ids, model, resolved tools, permission mode, `RunBudget` (retried spend in `budget.used.retried`), deadline, inputs, delivery, `planFirst`, queue position, result), `SpecialistResult` (outcome `done | partial | failed | cancelled`, summary ≤ 600, findings ≤ 12, artifacts, `next` ≤ 2, gaps, receipts, `tainted`, `stopReason`, evaluator verdict, defaults used), `SpecialistInputs`, `ApprovalHint`, `SpecialistRole` and `SpecialistJob` (status `queued | working | needs_you | done | partial | failed | cancelled`).
- `Task.specialist?`, `TaskCreateInput.specialist?`, `ApprovalRequest.requestedBy.parentRunId?` / `.specialist?`, `NotificationKind` gains `specialist_result`, `Automation.specialist? {role, budget?, deliver?}`.
- Methods `specialists.list`, `specialists.jobs`, `tasks.steer` (side-effecting) and `tasks.update` (side-effecting, owner-only budget or deadline change).
- Events `specialist.spawned`, `specialist.progress` (≤ 1/s, labels only) and `specialist.result`.
- `AgentEvent` gains `{type: "subagent", runId, messageId, toolCallId, taskId, childRunId, status, label, progress?, usage?}`, the run trace's `subagent` step.
- Fakes: `FakeTaskEngine` stores `specialist`; `FakeAgentLoop` scripts the new event.

### v1 additive — 2026-10-25 (S09, #637: Apple app capabilities, wave 1)

For S14 / the helper session (H, #638) and S09 (G, #639): the shapes of docs/connectors/apple-apps-2026.md wave 1. All new fields are optional and all new schemas are new names.

- Shared: `AppleAlarm` (relative minutes or an absolute time), `AppleRecurrence` (an RRULE subset).
- Calendar: `AppleCalendarEvent` gains `attendees` (read-only), `conferenceUrl`, `alarms`, `recurrence`, `availability`; `AppleCalendarListEventsParams.query`; `AppleCalendarEventInput` / `AppleCalendarEventUpdate` gain `alarms`, `recurrence`, `availability`. New `AppleCalendarFreeBusyParams` + `AppleBusyBlock` (C2), `AppleCalendarDeleteEventParams` (C4).
- Reminders: `AppleReminder` gains `url`, `flagged`, `alarms`, `recurrence`; `AppleRemindersListParams` gains `overdue`, `dueToday`, `flagged`, `query`; `AppleReminderInput` gains `url`, `alarm`, `recurrence`. New `AppleRemindersCompleteParams` (R3), `AppleRemindersDeleteParams` (R4), `AppleRemindersSetFlaggedParams` (R5).
- Mail: `AppleMailMessageSummary` gains `flagged`, `link` (`message://`); `AppleMailMessage` gains `attachments`. New `AppleMailMailbox` (M2), `AppleMailSelectedParams` (M3), `AppleMailReplyDraftParams` / `AppleMailForwardDraftParams` / `AppleMailDraftRef` (M5), `AppleMailSendDraftParams` (M6: the draft id with its expected recipients, subject and body hash, which the approval binds and the helper re-checks), `AppleMailSetFlagsParams` (M7), `AppleMailMoveParams` (M8), `AppleMailSaveAttachmentsParams` + `AppleSavedFile` (M9).
- Notes: `AppleNoteSummary.snippet`, `AppleNote.attachments` / `bodySha256`, `AppleNoteInput.format` (text / markdown). New `AppleNotesSearchParams` (N1), `AppleNoteFolder` (N2), `AppleNotesAppendParams` (N3), `AppleNotesUpdateParams` (N4, bound to `previousBodySha256`).
- Contacts (new): `AppleContactSummary`, `AppleContact`, `AppleContactsSearchParams`, `AppleContactInput`, `AppleContactUpdate`.
- Music (new): `AppleNowPlaying`, `AppleMusicControlParams`, `AppleMusicSearchParams`, `AppleMusicItem`, `AppleMusicPlayParams` (Music and Spotify).
- Safari / Chrome: `AppleTabTextParams` + `AppleTabText` (S1), `AppleReadingListParams` (S3); Chrome tabs reuse `AppleSafariTab`.
- Files (new): `AppleFileItem`, `AppleFilesRecentParams`, `AppleFilesMoveParams`, `AppleFilesRenameParams`, `AppleFilesTrashParams`.
- Shortcuts (new): `AppleShortcut`, `AppleShortcutsRunParams`, `AppleShortcutResult`.
- Things 3 (new): `ThingsTodo`, `ThingsListParams`, `ThingsAddParams`, `ThingsUpdateParams`, `ThingsCompleteParams`.

### v1 additive — 2026-10-25 (S02, #632: reasoning steps)

- Event `chat.reasoning { threadId, runId, stepId, delta?, summary?, done? }`: one step per contiguous reasoning block of a running agent message, for the run's step log. Transient (never persisted); off when the setting `agent.showReasoning` is `false`.
- `ModelEvent` `reasoning` gains optional `summary` (a provider summary when no text streams); `AgentEvent` gains `{ type: "reasoning", runId, messageId, stepId, delta?, summary?, done? }`.

### v1 additive — 2026-10-25 (S09 + S14, #626: Apple Mail search filters)

For S14 (the helper's `mail.search`) and S09 (the Apple Mail connector's `mail_search` tool).

- `AppleMailSearchParams.query` is optional now (absent or empty matches every message), and new optional `unread` (true unread only, false read only), `since` / `until` (date received) and `from` (sender contains). Results come newest first.

### v1 additive — 2026-10-25 (#599 the sidebar's usage footer)

For S11 (the sidebar footer) and S01 (the Gateway handler, `apps/gateway/src/compose/usage-summary.ts`).

- New schemas `UsageTally`, `UsageByModel` (with `subscription` for the Claude Code / Codex CLIs), `UsageDay`, `UsageToday`, `UsagePlanWindow` (`schemas/usage.ts`).
- New method (operator.read): `usage.summary {days?, timeZone?}` → `{days, today, byModel, month, budgetUsd, primary, planWindow}`. Tokens are input + output + reasoning (cache reads excluded), counted from the runs table in the owner's time zone. `budgetUsd` is the new `usage.monthlyBudgetUsd` setting. `planWindow` stays null until an adapter can read a subscription's rate-limit window; clients must not estimate one.

### v1 additive — 2026-10-24 (#555 the first message after onboarding)

For S01 (the Gateway handler and `SessionController.greet`) and S11 (the web client calls it when onboarding completes).

- New method (operator.write, side-effecting): `chat.greet {threadId}` → `{started, runId}`. Starts the agent's first message in an empty thread: a turn with no user message, from a fixed Gateway prompt (BOOTSTRAP.md guides it while it exists). `started: false` when the thread has any message or a run.

### v1 additive — 2026-10-21 (S09, #529: adding an MCP server from Settings)

For S09 (the Gateway's MCP part) and the Settings → MCP section.

- New schemas `McpServerInput` (id, name, stdio `command` + `env` or HTTPS `url` + `auth`, `allowedDomains`), `McpProbedTool`, `McpProposal`, `McpProbeResult`.
- New methods (admin, side-effecting): `mcp.probe {server}` → `{proposal, approval}` (runs the server sandboxed, lists its tools without registering them, opens a device-only `skill_install` trust card with `details.kind: "mcp_server"`); `mcp.add {proposalId, approvalId}` → `{server}`; `mcp.remove {serverId}` → `{ok}`.

### v1 additive — 2026-10-20 (#509 learned facts about the owner)

For S02 (the learner), S07 (`USER.md`'s Learned section), S11 (the Settings switch and the chat note).

- New schema `LearnedFact {factId, text, kind, date, threadId}` (`schemas/memory.ts`).
- New block `LearnedBlock` (`type: "learned"`, 1–10 items) at the end of the `Block` union: the "Learned: …" note with Undo.
- New method `memory.forgetLearned {factId}` → `{removed}` (write, side-effecting): Undo.
- `apps/gateway` `blockToMarkdown` handles the new block.

### v1 additive — 2026-10-21 (S09, #505: a real connect flow)

For S09 (the Gateway handlers and the asynchronous OAuth connect) and S11 (onboarding and Settings → Connectors read and drive it).

- New methods `connectors.catalogue` (`operator.read`), `connectors.connect` (`operator.admin`), `connectors.disconnect` (`operator.admin`), `connectors.status` (`operator.read`), `connectors.setMatrix` (`operator.admin`). They were defined locally in `@psyche/connectors` and never mounted, so no client could connect anything.
- `connectors.connect` returns at once. An OAuth connector comes back `needs_auth` with `authorization` (`url`, optional `userCode`, `expiresAt`, `opened` when the Gateway already opened the page on its machine); the outcome arrives as the new event `connectors.updated` (`connector`, `reason`, optional `error`).
- New schemas `ConnectorCatalogueEntry` (with optional `configured`: false when the Gateway lacks e.g. the OAuth client id), `ConnectorCatalogueAction`, `ConnectorAuthorization`.

### v1 additive — 2026-10-20 (S17: voice mode, Q5)

For S17 (`packages/speech` read-aloud), S11 (the shell's voice mode), S01 (mounting; `SPEECH_METHODS` mounts the new method automatically).

- `speech.readAloud` gains optional `save: boolean` (default `true`). With `false` the reply is streamed as `speech.audio` only: no Library item and no `speech.readAloud.completed`; `speech.audio {last: true}` marks the end. Voice mode speaks every reply this way instead of filing an MP3 per turn.
- New `speech.readAloud.cancel {streamId}` → `{ok: true}` (`operator.write`): stops one of the caller's own streams for barge-in; `speech.readAloud.failed` reports `cancelled`. Another device's stream id is treated as unknown.
- No fake changes (no contract changed).
### v1 additive — 2026-10-20 (S10: WhatsApp channel secrets, N6)

- `ChannelSecretName` gains `access_token`, `app_secret` and `verify_token` (appended): the WhatsApp Cloud API's Graph access token, the Meta app secret that signs webhooks (`X-Hub-Signature-256`) and the webhook verify token. Stored by `channels.secrets.set` as Gateway-owned vault items.
### v1 additive — 2026-10-20 (S09, M9: custom connectors)

For S09 (the manifest executor and proposal flow in `@psyche/connectors`), S12 / S11 (the trust card and Settings → Connectors), S01 (mounting).

- New schemas `CustomConnectorManifest` (`schemaVersion: 1`, `id`, `name`, `description`, `version`, `baseUrl` (https), `hosts` allowlist, `auth`, `tools[]`, optional `source`), `CustomConnectorAuth` (`none` | `bearer` | `header` | `query` | `basic`, each with a `{{cred:slug}}` placeholder), `CustomConnectorTool` (`name`, `description`, `method`, `path` with `{param}`, `params[]` in path / query / body, `sideEffect` read | write | destructive, optional `defaultRule`), `CustomConnectorParam`, `CredentialPlaceholder`, and `CustomConnectorProposal` (`kind: "connector"`, `approvalKind: "skill_install"`, the manifest, its canonical `text` and `hash`, `findings`, `scopeMode`, `bindingHash`, `grantKey`, `expiresAt`, optional `update` diff).
- New methods `connectors.proposeCustom` (`operator.admin`; a manifest or an OpenAPI document; opens a device-only `skill_install` approval with `details.kind: "connector"`), `connectors.getCustomProposal` (`operator.read`), `connectors.installCustom` (`operator.admin`; needs the approved `skill_install`) and `connectors.removeCustom` (`operator.admin`).
- No fake: connectors have no contract in `src/contracts`.
### v1 additive — 2026-10-20 (S08, I14: Web Bot Auth)

For S08 (the browser signs document requests), S06 (the vault keeps the key) and S11 / S12 (Settings → Browser).

- `CredentialBroker` gains optional `botAuthKey()` and `rotateBotAuthKey()`, returning a `BotAuthKey` (`keyId` = RFC 7638 JWK thumbprint, `publicJwk`, `createdAt`, `sign(data)`). The private half never leaves the vault. `FakeCredentialBroker` implements both with a real Ed25519 key, and a rotated-away key refuses to sign.
- Schemas `BotAuthJwk` and `BotAuthStatus` (`enabled`, `keyId`, `publicJwk`, `createdAt`, `signatureAgent`, `directoryPath`, `origins`, `advertised`).
- Methods `browser.botAuth.status` (`operator.read`) and `browser.botAuth.rotate` (`operator.admin`, side-effecting).
- The switch itself is the admin setting `browser.botAuth {enabled, signatureAgent?, origins?}` (no protocol change).
### v1 additive — 2026-10-20 (M3 T3: agent-proposed skills)

For S16 (`packages/skills` draft generator), the Gateway (routine detection over agent-core's in-process hooks) and Settings → Skills (S11 / S12).

- New `SkillDraft {id, threadId, name, description, text, manifest, steps, occurrences, signature, redactions, tainted, edited, status, createdAt, updatedAt, installProposalId?, approvalId?, replay?}`, `SkillDraftStatus` (`open | accepted | installed | dismissed | expired`), `SkillDraftStep {tool, sideEffect, summary}`, `SkillDraftReplay {ok, problems, checkedAt}`.
- New methods: `skills.drafts.list {status?}` (`operator.read`); `skills.drafts.update {draftId, text}`, `skills.drafts.accept {draftId}` → `{draft, proposal, approval}` (the T2 trust card), `skills.drafts.dismiss {draftId}` (all `operator.admin`, side-effecting).
- New event `skills.draft.updated {draft}`.

### v1 additive — 2026-10-20 (J8 teach mode)

For S14 (the helper's `teach.start` / `teach.stop` / `teach.cancel` / `teach.status`), S01 (Gateway: owner-only teach tools, review then workspace skill), S11 (recording indicator and review screen).

- New `schemas/teach.ts`: `TeachTarget`, `TeachStepKind` (click | right_click | double_click | type | press | skipped), `TeachScreenshot`, `TeachStep`, `TeachStartParams` {name?, description?, app?, screenshots?, maxSteps?, maxSeconds?}, `TeachSessionParams` {sessionId}, `TeachDraftFile`, `TeachEndedBy`, `TeachDraft` {sessionId, name, description, startedAt, endedAt, endedBy, steps, files}, `TeachStepEvent` (`teach.step`).
- The helper never saves a draft. Password-field input and input in off-limits apps are never recorded.
### v1 additive — 2026-10-20 (context usage, limits, compaction)

For S02 (the loop's accounting and auto-compaction), S01 (the handlers), S11 (the context meter, settings and compaction markers).

- New schemas (`schemas/context.ts`): `ContextBreakdown`, `ContextLimits`, `EffectiveContextLimits`, `ContextUsage`, `CompactionSummary`, `CompactionResult`.
- New block `CompactionBlock` (`type: "compaction"`) at the end of the `Block` union.
- New methods: `threads.contextUsage` (read), `threads.setContextLimits` (write), `threads.compact` (write, side-effecting).
- New event `thread.context.updated {usage}`.
- `apps/gateway` `blockToMarkdown` handles the new block (exhaustive switch).

### v1 additive — 2026-10-20 (L7 prebuilt guest images)

For S14 (the helper's image export / import and `deploy/macos/build-guest-image.sh`), S01 (Gateway: `vm.create {image}`), S11 (Devices: "Create from image").

- `VmCreateParams` gains optional `image` (a guest image directory or `.aar`) and `imageSha256` (expected SHA-256 of its `manifest.json`).
- New `VmImageFile` {name, bytes, sha256} and `VmImageManifest` {format "psyche-guest-image", formatVersion 1, id, guestOS, diskFormat, diskGB, username, createdAt, provisioned, psycheInstalled, permissionsGranted, psycheVersion?, files}.
- New `VmExportImageParams` {name?, outDir, id?} and `VmExportImageResult` {path, manifest, manifestSha256} for `vm.export_image`.
- `VmGuest` gains optional `image` {id, guestOS, createdAt} and `passwordRotationPending`.
- `VmProgressEvent.type` gains `vm.import` and `vm.export` (at the end).
### v1 additive — 2026-10-20 (L6: Gateway methods for snapshots and resets)

For S01 (the Gateway serves them over S14's helper capabilities) and S11 (Settings → VM mode). Builds on the L6 shapes (`VmSnapshot`, `VmSnapshotResult`, `VmRestoreResult`).

- New methods in `methods/vm.ts`:
  - `vm.snapshots.list {}` → `{snapshots, baseSnapshot}`, `operator.read`;
  - `vm.snapshots.create {label?, base?}` → `VmSnapshotResult`;
  - `vm.snapshots.restore {snapshot}` → `VmRestoreResult`;
  - `vm.snapshots.reset {}` → `VmRestoreResult`;
  - `vm.snapshots.delete {snapshot}` → `{deleted}`.

  All the changing ones are `operator.admin`, side-effecting and audited as receipts.

### v1 additive — 2026-10-20 (L6 VM snapshots and resets)

For S14 (the helper's `vm.snapshot` / `vm.restore` / `vm.reset` / `vm.snapshot_delete`), S01 (the Gateway half: compose tools, "fresh Mac per task", broker sides), S11 (the Devices pane).

- New `VmSnapshot` {id, label, kind (`VmSnapshotKind`: base | manual | task), taskId?, createdAt, guestOS, bytes, savedState, provisioned, psycheInstalled, method (`VmSnapshotMethod`: apfs-clone | overlay)}.
- `VmGuest` gains optional `snapshots` (newest first) and `baseSnapshot`.
- New params/results: `VmSnapshotParams`, `VmSnapshotResult`, `VmRestoreParams`, `VmResetParams`, `VmRestoreResult` {guest, snapshot, durationMs}, `VmSnapshotDeleteParams`.
- `VmProgressEvent.type` gains `vm.snapshot` and `vm.reset` (at the end).
- `VM_SETTING_KEYS.resetPerTask` (`vm.resetPerTask`, default false) and optional `VmSettings.resetPerTask`.

### v1 additive — 2026-10-20 (E12 "From your other chats")

For S02 (agent-core's context providers), S01 (the Gateway's thread digests), S11 / S12 (the block in the chat).

- New block `RelatedThreadsBlock` (`type: "related_threads"`, 1–5 `RelatedThread {threadId, title, snippet, lastMessageAt}`) at the end of the `Block` union: the owner's other chats a turn drew on, shown collapsible in the reply. Titles and snippets are untrusted data, rendered as plain text.

### v1 additive — 2026-10-20 (T4 code plugins)

For S02 (agent-core's plugin seam and `packages/plugins`), S01 (the Gateway's plugins part), S11 (a Settings → Plugins pane later).

- New methods in `methods/plugins.ts`: `plugins.list` (read), `plugins.getProposal` (read), `plugins.proposeInstall {path}`, `plugins.install {proposalId, approvalId}`, `plugins.setEnabled {name, enabled}`, `plugins.remove {name}` (admin, side-effecting). Installing reuses the device-only `skill_install` approval with `details.kind: "plugin"`; nothing runs while the admin setting `plugins.enabled` is off.
- New schemas: `PluginName`, `PluginCapability` (`context`, `before_tool_call`, `after_tool_call`, `agent_end`, `evaluate`), `PluginManifest`, `PluginStatus`, `PluginSummary`, `PluginProposal`.
### v1 additive — 2026-10-20 (S10: channel transport secrets, N8 / N9)

- `channels.secrets.set {type, account, name, value}` → `{set}` (`operator.admin`, side-effecting, params never logged) and `channels.secrets.status {type, account}` → `{required, set}` (names only), with `ChannelSecretName` (`bot_token | app_token | auth_token`). The Gateway stores each as a Gateway-owned vault item (like `models.setKey`), read by the Slack, Discord and SMS adapters per connection or request; never fillable by agents.

### v1 additive — 2026-10-20 (desktop bundle: first admin without a terminal)

For the desktop bundle session and S01 (the Gateway handler), approved by the architecture session.

- New method `devices.bootstrapAdmin {}` → `{device}`, `operator.write`, side-effecting. Grants `operator.admin` to the calling desktop shell only while no admin device exists (one transaction), audited as `device.bootstrap_admin`. `forbidden` for any caller but the desktop shell's own connection, `conflict` once an admin exists.

### v1 additive — 2026-10-20 (desktop bundle: first run from scratch)

For the desktop bundle session (onboarding's Model & provider step) and S01/S03 (the Gateway's model router reads it).

- New method `models.setKey {providerId, key}` → `{provider: ModelProviderSummary}`, `operator.admin`, side-effecting. Stores a hosted provider's API key in the vault as a Gateway-owned item, so a packaged install answers chat with no environment variables. The key is never logged or returned.

### v1 additive — 2026-10-20 (#272: pause-when-unwatched signal from the desktop)

For S11 (the desktop reports it), S01 (the Gateway's attention check), and S08 (browser panes).

- New method `attention.report {pane: "browser" | "computer", visible, input?}` → `{ok: true}`, `operator.write`, desktop shell only. The desktop reports pane visibility and owner input, so actions on sensitive apps and origins need the pane visible and recent input (docs/05 §7.2 item 5).
- New `AttentionPane`.

### v1 additive — 2026-10-20 (S09, #281: MCP tool descriptions carry provenance)

For S09 (mcp-host sets it), S02 (the loop may taint a turn whose tools include untrusted descriptions) and the model router (S03, marking).

- New optional `ToolSpec.descriptionProvenance: "trusted" | "untrusted"`: who wrote the tool's `description` and the text in its `inputSchema`. `untrusted` for non-bundled MCP servers; absent means Psyche's own tool text.
- `FakeMcpHost` sets it from the server's trust tier.
### v1 additive — 2026-10-20 (S06: Settings → Credentials, payments and 1Password)

- `vault.linkExternal` (operator.admin, side-effecting): links a 1Password item (G10) by `OnePasswordRef` `{vault, item}` with the fields it offers; Psyche stores the reference, never a value.
- `vault.payments.list` (operator.read): Stripe Link spends as `VaultPayment`, newest first, optionally per task. Each carries the merchant, the amount in minor units, Link's status, the lifecycle `payment {state, held, captured, refunded}`, brand / last4 of the one-time card and of its funding method, and the merchant refs. Never card data.
- `vault.payments.methods` (operator.read): the owner's Link payment methods as `LinkPaymentMethod`, redacted.
- Event `vault.payment.updated {payment}`.
- `CredentialMeta.backend` (optional): `vault | keychain | 1password`.

### v1 additive — 2026-10-20 (S22, M3 security audit completeness)

- New `mcp.status` (`operator.read`) → `{launcher: "srt" | "container" | "none", servers: McpServerStatus[]}` (`id`, `name`, `trust`, `transport`, `network`, `connected`): how the composed Gateway isolates MCP servers, for `psyche security audit`.
- `sandbox.status` result gains optional `egress` (the host egress proxy for `network: "proxy"` sandboxes is running, security §5.2).
- No fake changes: no contract changed.
### v1 additive — 2026-10-20 (#275: forwarded and quoted text taints the turn)

For S01 (channel turns), S02 (the loop starts the turn tainted with them).

- New optional `StartTurnInput.taintSources`: untrusted content inside the input itself, such as forwarded or quoted third-party text in an owner's message. The turn starts tainted with these sources.

### v1 additive — 2026-10-20 (M3 hardening, issues #279 and #280)

- `ToolCallMeta` gains optional `mcpServerId`, `mcpToolsListHash` and `mcpTier`: an MCP tool's description carries them to the broker, so its grants are bound to the server and `tools/list` hash, and unknown-tier write tools ask. No fake change.

### v1 additive — 2026-10-20 (M3 gateway hardening, issue #253)

- New `devices.presenceKey.list`, `devices.presenceKey.register` (side-effecting; optional `expectKeyId`, `approvalId`) and `devices.presenceKey.remove` (side-effecting), all `operator.admin`: the owner registers a paired helper's Secure Enclave presence key, so Touch ID answers from that helper verify. New schema `PresenceKeyInfo` (`deviceId`, `keyId`, `registeredAt`).
- No fake change.

### v1 additive — 2026-10-19 (V10 coding helper: git approval kinds, sandbox mounts)

For the V10 coding helper (S02 scope: `code.*` tools in `packages/agent-core`), S05 (cards and scopes), S21 (the container runner mounts) and the Gateway's `compose/coding.ts`.

- `ApprovalKind` gains `git_write` (commit, branch) and `git_push` (push: repository, remote, remote URL, branch and commit in the binding; `once` only, never forced).
- New `SandboxMount {source, target, readOnly}`; `SandboxRunner.ensureSandbox(scope, {network?, mounts?})` takes optional bind mounts of host folders, fixed when the scope's sandbox is created (`conflict` on a mismatch, `forbidden` for a source the runner refuses); `SandboxInstance.mounts?` reports them. The fake keeps mounts and refuses targets outside `/workspace/`.
### v1 additive — 2026-10-20 (S14 M3: VM mode, rest of L1–L5)

For S14 (helper `vm.*`), S01 (sandbox runner "vm" mode, `vm.updated` rebroadcast), S11 (Settings → Devices).

- `VmPhase` gains `paused` and `saved` (appended).
- `VmGuest` gains optional `display`, `clipboard` (the existing `VmClipboardMode`: paste-only / bidirectional / off), `vault` (`VmVaultPlacement`: host / guest), `agent` (`VmGuestAgentStatus`), `psycheInstalled`, `permissionsGranted`, `savedState`, `transfers` (`VmTransfer[]`).
- New `VmConfigureParams`, `VmCopyInParams`, `VmCopyOutParams`; `VmProgressEvent.type` gains `vm.psyche_install` and `vm.permissions`.
### v1 additive — 2026-10-19 (M3 gateway hardening, docs/status/s05.md §2)

- Error code `presence_required`: a security change needs fresh presence and no verifier on this Gateway can give one (presence was enrolled, then every passkey and helper key was lost or revoked). The UI tells the owner to add a passkey or register the helper's key.
- Optional `approvalId` on `devices.approve`, `channels.configure`, `channels.allowlist.update`, `channels.pairing.approve`, `channels.identities.upsert`, `memory.reset`, `backup.delete` and `passkeys.register.finish`: the same fresh-presence round trip `settings.set` already has (the first call fails `approval_required` with `details.approvalId`; retry with it once the device-only `policy_change` card is approved).
- `AuditVerifyResult` gains optional `signedAnchors`, `anchorKeyIds` and `signingSinceSeq` (signed audit anchors, security §15.1).
- No fake change: no contract interface changed.
### v1 additive — 2026-10-19 (M3 model adapters: Settings → Model & providers, B1/B4)

For the model router (S03 M3: endpoint probe), the Gateway (`models.*` handlers) and Settings → Model & providers in `packages/ui` / `apps/web`.

- New methods in `methods/models.ts`:
  - `models.list {}` → `{providers: ModelProviderSummary[], roles: ModelRoles}` (`operator.read`): configured providers, their known models with tool-check verdicts, and the last endpoint probe (`not_probed` until one runs).
  - `models.probe {providerId}` → `{provider}` (`operator.admin`): reachability, model list and capability guesses for one configured provider; runs only when the owner asks.
  - `models.check {ref}` → `{result: ToolCheckResult}` (`operator.admin`): the six-case tool-calling check (B4).
  - `models.setRole {role: "primary" | "utility", ref, override?}` → `{roles}` (`operator.admin`, side-effecting): binds and persists a role; `policy_denied` for a chat-only primary without `override`.
- New schemas in `schemas/models.ts`: `ModelFactSource`, `ModelCapabilityGuess`, `ProbedModel`, `EndpointProbeState`, `EndpointProbe`, `ToolCheckStatus`, `ToolCheckResult`, `ProviderModelEntry`, `ModelProviderSummary`, `PickableModelRole`, `ModelRoles`.
### v1 additive — 2026-10-19 (M3 T2: skills install and trust)

For S16 (`packages/skills`), the Gateway (`skills.*` handlers), S05 (`skill_install` binding) and Settings → Skills (S11 / S12).

- New `SkillManifest {tools, permissions: ApprovalKind[], prompts}`: what a skill declares it needs. Optional `manifest` on `SkillDetails` and `SkillProposal`; optional `manifest` on the contract's `SkillInstallProposal` (`SkillManifestDecl`).
- New `SkillUpdateStatus {name, installedHash, availableHash?, commit?, updateAvailable, manifestChanged, error?, checkedAt}`; optional `update` on `SkillDetails`.
- New method `skills.checkUpdates {name?}` → `{updates: SkillUpdateStatus[]}` (`operator.admin`, no install) and event `skills.updated` (payload `SkillUpdateStatus`) for each update found. Optional `SkillLoader.checkUpdates`.
- `skills.proposeInstall` documents its refusal: `policy_denied` with `details.violations` when the manifest asks for more than the owner's policy allows (no approval card is opened).
- `@psyche/permissions`: `skill_install` gets a dedicated binding `{name, scope, source, commit?, treeHash, tools, permissions, prompts}` (lists sorted, de-duplicated; grant key `{name, scope}`), joins `DEVICE_ONLY_KINDS`, and its card lists name, source, hash, permissions, tools and prompts first (`none` when empty).
### v1 additive — 2026-10-19 (M3 VM mode, Gateway side: Task workspace, L1–L5)

For S01 (the Gateway's `vm` runner and Task mode selection), S04 (tasks persist the workspace), S02 (`task.start` may name it), S11 (Settings → VM mode).

- New `TaskWorkspace` (`sandbox | vm`). `Task.workspace` and `TaskCreateInput.workspace` are optional: absent means the owner's default.
- `SandboxBackendKind` gains `vm`, the runner that executes in the sandbox Mac guest through its psyche-node. `@psyche/sandbox`'s `ContainerBackendKind` excludes it (one line).
- `schemas/vm.ts`: `VM_SETTING_KEYS`, which name the admin-only settings `vm.enabled`, `vm.guestNodeId`, `vm.defaultWorkspace`, `vm.clipboard` and `vm.credentials`, plus `VmSettings` and `VmClipboardMode` for typing them.
- `FakeTaskEngine` keeps `workspace`.

### v1 additive — 2026-10-19 (M2 computer use: per-app tier keys on the action)

For S02 (the loop passes it through), S05 (the broker's per-app tier check) and the Gateway's computer-use tools (`computer.act`, `apps.open`, `apps.focus`).

- New `ToolCallMeta {app?, action?}` and optional `meta` on `ToolCallDescription` and `ToolCallIntent`: the executor names the computer-use app and action, and the broker's tier check needs the tier of that action (`click` for a click, `interact` for typing) instead of the tool name's, which made every `computer.act` need `interact`.

### v1 additive — 2026-10-19 (S11 M2: Files pane and viewers, P4)

For S11 (the Files pane and chat attachments render `@psyche/viewers`), S01 (the Gateway serves them), S13 (a `ConversionService` over the Gateway).

- New methods in `methods/files.ts`, all `operator.read`:
  - `files.list {path, offset?}` → `{entries: FileEntry[], nextOffset}`: a folder inside a granted folder, 500 entries per page.
  - `files.read {path | libraryPath, offset?, length?}` → `{name, mime, modifiedAt, etag, size, offset, bytes (base64), nextOffset}`: a chunk of a file in a granted folder or the Library.
  - `documents.convert {path | libraryPath, target: "pdf" | "thumbnail", offset?, length?}` → `{mime, size, offset, bytes, nextOffset}`: LibreOffice in the sandbox, cached by etag; `unavailable` with `details.reason` `sandbox_unavailable` or `image_missing`.
- New schemas: `FileEntry`, `FileEntryKind`, `ConversionTarget`; constants `FILE_CHUNK_BYTES` (512 KiB, so a base64 chunk stays under `MAX_FRAME_BYTES`) and `FILE_LIST_PAGE` (500).

### v1 additive — 2026-10-19 (S14 M2: Apple app adapters, J6)

For S14 (the mac helper's `calendar.*`, `reminders.*`, `mail.*`, `notes.*`, `finder.*`, `safari.*` node capabilities), S02 (typed node tools), S05 (the `apple.<app>` connector matrix).

- New schemas in `schemas/apple-apps.ts`: `AppleCalendar`, `AppleCalendarEvent`, `AppleCalendarListEventsParams`, `AppleCalendarEventInput`, `AppleCalendarEventUpdate`, `AppleReminder`, `AppleRemindersListParams`, `AppleReminderInput`, `AppleReminderUpdate`, `AppleMailMessageSummary`, `AppleMailMessage`, `AppleMailSearchParams`, `AppleMailDraftInput`, `AppleNoteSummary`, `AppleNote`, `AppleNoteInput`, `AppleFinderEntry`, `AppleSafariTab`.
- No new methods: the capabilities are reached through `nodes.invoke` (and the agent's node tools) as `node.<capability>`; app content they return is `untrusted`.
### v1 additive — 2026-10-19 (M2 computer use: script and Shortcut approval kinds, J4)

For the Gateway's computer-use tools (`apps.applescript`, `apps.jxa`, `apps.shortcut_run`), S05 (card titles, scopes) and S10 / S11 / S12 (card labels).

- `ApprovalKind` gains `apple_script` and `shortcut_run` at the end of the list: running AppleScript / JXA or a user Shortcut gets its own card showing the exact source (or name and input) instead of a generic "Use app". Both are `destructive` and offer `once` only: the approval binds the exact params (security §5.4).
### v1 additive — 2026-10-19 (S14/S11: system-wide dictation, J9 / Q2)

For S14 (the helper's `dictation.*` capabilities), S01 (the Gateway forwards the methods to the local mac-helper), S11 (the desktop hotkey, HUD and Settings).

- New methods `dictation.target` (focused app and element, whether it can take text), `dictation.insert` (side-effecting: AX insertion with a CGEvent typing fallback, optional `expectPid`) and `dictation.watch` (hold-to-talk modifier watch; `key: null` stops). All `operator.write`; the Gateway serves them to desktop devices only and never through `nodes.invoke` or agent tools.
- New schemas `DictationKey` (`fn | rightOption | rightCommand`), `DictationTarget`, `DictationRefusal` (`no_focus | secure_field | own_window | not_editable | focus_changed`), `DictationInsertMethod` (`ax | typed`), `DictationKeyPayload`.
- New event `dictation.key` (`{key, down, at}`), sent only to the watching device.
- The helper's capabilities take the same params and results, so the generated Swift `DictationInsertParams` / `DictationTarget` are its typed params. Inserted text is keystrokes into another app, never owner input to the agent.
### v1 additive — 2026-10-19 (M2 messages: J7 / N5)

For S14 (the mac helper's `messages.*` capabilities), S10 / N5 (the iMessage channel adapter) and S05 (`message_send` approvals).

- New `schemas/messages.ts`: `MessagesService` (`imessage | sms | rcs | unknown`; `sms` / `rcs` senders are weak identities), `MessagesCursor` (chat.db `message.ROWID`), `MessagesHandle`, `MessagesChat`, `MessagesAttachment` (metadata only, with `isVoiceNote`), `MessagesReaction` / `MessagesReactionKind` (tapbacks), `MessagesMessage`, `MessagesStatus` / `MessagesAutomationStatus`, and params / results for the node capabilities `messages.status`, `messages.chats`, `messages.read`, `messages.send` (`MessagesSendService`) and `messages.watch` (streaming; its `node.event` data is `MessagesWatchEvent`: `messages.new {messages, cursor}` or `messages.watch_error {reason, retryable}`).
- `MESSAGES_CAPABILITIES`: the manifest entries a Messages node declares. `messages.send` is `destructive` with `targetKind: recipient`, so the existing `message_send` approval kind applies with `once` / `task` scopes only (security §3.4, §3.5). No new approval kind.
- No Gateway broadcast event: message bodies flow only on the node invocation to the channel adapter, never to every paired client.
- Fakes: new `FakeMessagesNode` (an in-memory chat.db behind `FakeNodeClient`); `FakeCapabilityHandler.handle` gets the invocation's `AbortSignal` as an optional third argument so streaming handlers can end.

### v1 additive — 2026-10-21 (S01: web passkeys, #79)

- `passkeys.register.begin | register.finish | reauth.begin | list | remove` and `PasskeyInfo`, `PasskeyReauth`: WebAuthn passkeys per device for the server-mode web client. Options and responses use the WebAuthn JSON forms. A device that already has a passkey re-authenticates with one before adding or removing another.
- `ApprovalAnswer.presence` (optional, `PresenceAssertion`): the fresh-presence assertion S05's `approvals.answer` handler already reads (`webauthn` from passkeys, `helper` from Touch ID). It is now declared in the schema.

### v1 additive — 2026-10-19 (S02/S04: write-ahead dispatch hook, #63)

For S02 (`agent-core` awaits it before every dispatch) and S04 (`TaskWorkerPool` commits the step's `running` checkpoint in it).

- `StartTurnInput` gains optional `beforeDispatch(call: DispatchIntent) => Promise<void>`, awaited immediately before each tool call is dispatched (after the broker and any approval). A rejection blocks the call. New contract type `DispatchIntent` (`toolCallId`, `tool`, `sideEffect`, `approvalId?`). Contract-only (a function, not on the wire): no generated-file change.
- `FakeAgentLoop` awaits it before yielding a scripted `tool_call` `running` event and no longer records it in `turns`.

### v1 additive — 2026-10-19 (S02/S05: task_start approval kind, #48)

For S02 (`task.start` declares `sideEffect: write` and `kind: task_start`), S05 (the broker infers `task_start` for `task.start` and titles its card), S10 (chat card label), S11 / S12 (approval cards).

- `ApprovalKind` gains `task_start` at the end of the list: delegating a background task is a `write` (review design-08) with its own card instead of a generic `connector_action`. Offered scopes follow the `write` class (`once / task / site / session / always`); in a tainted turn it always asks (no target, so the target is new).
### v1 additive — 2026-10-19 (P9 file tools, #49)

For `@psyche/files` and the approval cards (S11 / S12). `ToolCallDescription` gains optional `details?: JsonObject`: what the approval card shows besides the params, display only and never part of the binding. The agent loop spreads it into `ApprovalRequest.details` under `tool`, `params` and `target`, which it cannot override. `write_file` / `edit_file` use it for `{path, operation, diff}`, which the UI kit's `file_write` card already renders.
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
