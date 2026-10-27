# @psyche/testing

## Unreleased (pre-0.3.0)

### Minor Changes

- Background specialists (#682): `SpecialistSpec` on tasks, `SpecialistResult`, roles and jobs, `specialists.list` / `specialists.jobs`, `tasks.steer` / `tasks.update`, the `specialist.*` events, the `specialist_result` notification kind, `Automation.specialist` and the `subagent` agent event.
- Background specialists, part 2a (#683): a dedicated specialist pool (`specialists.maxConcurrent`, default 3, at most 2 per parent thread) with queue positions; the chat pool no longer claims specialist jobs; `ClaimOptions` origin and per-parent filters; the spawn pre-flight stored on `SpecialistSpec` and returned on `SpecialistJob`.

### Patch Changes

- Web Bot Auth (I14): optional `CredentialBroker.botAuthKey()` / `rotateBotAuthKey()`, `BotAuthStatus`, and the `browser.botAuth.status | rotate` methods; the fake broker signs with a real Ed25519 key.
- Mail and meeting workflow shapes (#670 W1): batch proposals and the `batch` approval kind, event triggers for automations, `FeedPost.kind` / `refs` / `card`, digest (with the graph's loops), meeting-prep and meeting-notes records, `proposals.*` methods and the `proposal.updated` event.
- The teaching loop's store and routing (#679): feedback events and lessons in the Gateway database, the lesson router with deterministic refusals and one destination per lesson, writers for SOUL.md, AGENTS.md, USER.md, the people graph, skills' LESSONS.md and automations, `feedback.*` and `memory.lessons.*` in the Gateway, approval answers as implicit evidence, and nightly dreaming scheduled at compose time.
- Remove all text-to-speech from the Gateway side: synthesis in `@psyche/speech` (Kokoro, ElevenLabs, read-aloud, voice catalog, the voice conversation manager), the voice-turn prompt section and `StartTurnInput.voice`, channel voice-note sending, and the synthesis half of the `SpeechEngine` contract. Speech to text is unchanged. The Gateway removes the stale voice and synthesis settings on start (`deleteSettings` in `@psyche/db`).

## 0.3.0-alpha.0

### Minor Changes

- 5d2cbeb: `threads.update` (permission mode and per-thread model) and `ModelCallOptions` (`threadId`, `runId`) on `ModelProvider.stream`; `FakeModelProvider.callContexts`.
- 0899f3b: Search scopes `ideas`, `goals`, `connectors` and optional hit fields (kind, group, provenance, highlights) with grouped results; `skills.*` methods and the `skills.changed` event; optional `SkillLoader.promptIndex`, `commands` and `setEnabled`, implemented by `FakeSkillLoader`.
- 5dcf208: Standing grants reach connector executors: the loop puts what authorized a dispatch (approval or standing grant, binding hash, scope) on `ToolRunContext.authority`, and the connector registry confirms a grant the way it confirms an approval. The sender of a channel turn travels as `StartTurnInput.requester` into `PermissionBroker.decide` and the approval card's context. Taint persists across kill/restart: `tool_call` events carry the persisted details, thread state keeps the taint sources, and tasks carry `taintSources`.
- c840e75: protocol: `AgentLoop.explainContext` with `ContextSection` / `ContextExplanation` (C11), `ToolRegistration.describeCall` with `ToolCallDescription` (security §3.5), and `MemoryStore.flush` for the pre-compaction flush (B7). Fakes implement all three.
- 2607fc3: Scheduler: `reminder` automation kind, watch config and `lightContext` on automations, `AutomationRun` and `UpcomingItem` schemas, `automations.runs` / `automations.upcoming` methods, `automation.updated` / `automation.run.started` / `automation.run.finished` events.
- d02b6ef: M10: shopping helpers over the browser driver (compare, cart, checkout hand-off with a `purchase` binding and no payment, schema.org Order parsing) and scenario V3 in the scripted runner up to the hand-off.
- d2c228c: M7b: IMAP / SMTP mail backend (minimal clients over implicit TLS, app passwords through `{{cred:slug}}`) behind the shared mail connector, plus `FakeImapServer`, `FakeSmtpServer` and in-memory socket pairs.
- 6dda211: M7a: a shared mail connector with Gmail's tool surface over a `MailBackend`, the JMAP (Fastmail) backend with `{{cred:slug}}` tokens resolved per call, an RFC 5322 / MIME parser for raw messages, and `FakeMailStore` + `FakeJmapServer` fakes.
- 31b5a1a: Injection runner: run the prompt-injection corpus against a stack (reference gate over the fakes by default) with a worst-case scripted model, and write a diffable JSON report (`pnpm check:injection`).
- fa2aa95: Resumability harness (`@psyche/testing/resumability`): kill a scripted Task at every kill point on the real task engine, agent loop and permission broker, restart on the same database, and check for duplicate side effects and receipt / transcript consistency (`pnpm check:resumability`).
- 67e84be: Scripted acceptance-scenario runner (`@psyche/testing/scenarios`): run V1 inbox triage, V2 calendar planning and V7 research brief against the real agent loop and Permission Broker with fixture-backed services, evaluating every hard and soft assertion (`pnpm check:scenarios`).
- 5c22001: Secret-leak checker: shared fixture registry loader, card / SSN / IBAN / bank-account / passport / private-key detectors, model-visible capture in the fakes, a Vitest guard (`@psyche/testing/vitest`) and the `pnpm check:secrets` CLI. The fake browser masks password fields in snapshots.
- 575ec90: Scenario V4 travel end to end (hold a cheaper fare, ticket it, refund it) through the vault's Stripe Link PaymentBroker in test mode; payment transitions can carry the approval that authorized them.
- 38f71de: Taint hand-offs from S02's loop-grants work: `Task.taintSources` is persisted in SQLite (design-08, #96), and the sandbox keeps file-level provenance on workspace files and exec results (`ExecRequest.provenance` / `taintSources`, `ExecResult.provenance`; design-07, #97).

### Patch Changes

- d4d9cec: Secret-leak checker: a digit run glued to letters or underscores (inside a hex hash or an id) is no longer read as a card number.
- 9bf2d62: Scenario `Stack` takes a live model through `StackOverrides.provider` (a real `ModelProvider` and the model ref it serves) for INT-3's live gates; tool-call records of a live model carry their arguments from the loop's `details.paramsRedacted`. Scripted mode is unchanged. The new `tests/acceptance` workspace package holds the Milestone 1 acceptance checks and scorecard.
- fa2bebe: Scenario `Stack` records every tool call's arguments through a `before_tool_call` hook, so a live model's parked call can be replayed after a restart (its details only arrive with the call's final event). Scripted mode is unchanged.
- 1cf5421: Scenario `Stack` accepts extra fake executors (`StackOverrides.impls`) and services for agent-core's built-in tools (`StackOverrides.services`: tasks, scheduler, notifier, memory), and `startRun` takes a run mode so an automation can start an unattended run. `World.tools` merges extra executors over its own. `tests/scenarios/validate.mjs --dir <path>` validates scenarios in another folder; the schema's receipt kinds gain `message.send`. Used by INT-3's Milestone 2 scenarios; the M1 scenarios are unchanged.
- cf3c922: Write-ahead dispatch (#63): the loop awaits `StartTurnInput.beforeDispatch` before every dispatch and `TaskWorkerPool` commits the step's `running` checkpoint there, so a crash never re-sends an applied effect. Restart re-issue (#64): a recovered Task turn waits on the card `reissue()` issued for the same call instead of showing the owner a second one. The resumability tests now assert both fixes.
- 2064c0c: An allowlisted (non-owner, non-designated) sender's turn gets no reads of the owner's sources (`requester:not_owner`); only `web_search` / `web_fetch` and no-effect calls remain (#293). The fake broker matches.
- 2be1a8a: An allowlisted sender's calls outside the route's `toolAllow` are refused (`requester:not_owner`), so chat-only routes (`toolAllow: []`, #321) get no tools at all (#293).
- ecf0dd5: `notify` to the owner needs no card in any mode but plan, tainted or not (`owner_inbox`, #307); the fake broker matches.
- 493b4a5: `messages.*` node capability schemas (J7 / N5): chats, messages after a chat.db cursor, send through Messages.app, a streaming watcher; plus `FakeMessagesNode`.
- 5e605af: Additive: `StartTurnInput.beforeDispatch` write-ahead hook and the `DispatchIntent` type (#63); `FakeAgentLoop` awaits it before a scripted dispatch.
- 3461262: `ToolSpec.descriptionProvenance` (optional): who wrote a tool's description and schema text; `FakeMcpHost` sets it from the trust tier (#281).
- 9bb5dd4: `safeFetch` checks every redirect hop against an `allowHop` policy (`originAllowlist`, canonical origins); `web_fetch` allows the request's origin plus the Task's origin set and refuses other hops with `redirect_not_allowlisted` (#72). The scenario world uses the real check.
- 69d934d: Injection corpus: `expected.approvalByMode` for per-mode card expectations; manual-mode destructive approvals offer `once` only (security §3.2) in the validator, the runner and `FakePermissionBroker`.
- e99009a: Skills install and trust (T2): `SkillManifest`, `SkillUpdateStatus`, `skills.checkUpdates`, the `skills.updated` event, and a dedicated device-only `skill_install` binding covering source, tree hash and the declared tools, approval kinds and prompt files.
- e4e6f97: V10 coding helper: `code.open`, `code.search`, `code.read`, `code.edit` (unified diffs), `code.run` (sandbox with the repository bind-mounted, `.git` read-only) and `code.git` (host git without hooks; pushes behind a `git_push` card, once only). The Gateway composes the tools after the sandbox part; the scenario Stack takes real tool registrations.
- 0c71158: `ApprovalKind` gains `git_write` and `git_push` (V10 coding helper; a push is offered `once` only), and `SandboxRunner.ensureSandbox` takes optional `mounts` (bind mounts of granted host folders, fixed per scope).
- 4b3f571: VM mode, Gateway side (L1–L5): a Task can name its workspace (`sandbox | vm`), `SandboxBackendKind` gains `vm`, and `VM_SETTING_KEYS` / `VmSettings` type the owner's VM-mode settings.
- Updated dependencies [428ec1e]
- Updated dependencies [a5cef4e]
- Updated dependencies [4f8dff6]
- Updated dependencies [353afa9]
- Updated dependencies [2558bfe]
- Updated dependencies [7ac975c]
- Updated dependencies [09c0c6f]
- Updated dependencies [d982437]
- Updated dependencies [c4175a2]
- Updated dependencies [493b4a5]
- Updated dependencies [eaf91c6]
- Updated dependencies [19c1ba5]
- Updated dependencies [4f74993]
- Updated dependencies [5e605af]
- Updated dependencies [8a8dacb]
- Updated dependencies [6665567]
- Updated dependencies [310ac67]
- Updated dependencies [2f63bac]
- Updated dependencies [dc190a6]
- Updated dependencies [5d2cbeb]
- Updated dependencies [0899f3b]
- Updated dependencies [08664c3]
- Updated dependencies [e54d672]
- Updated dependencies [3461262]
- Updated dependencies [8a9ee2c]
- Updated dependencies [f80b0ec]
- Updated dependencies [75a0f80]
- Updated dependencies [2e9c025]
- Updated dependencies [e4c109b]
- Updated dependencies [5dcf208]
- Updated dependencies [c840e75]
- Updated dependencies [2607fc3]
- Updated dependencies [4bc7113]
- Updated dependencies [515b904]
- Updated dependencies [f4cf9c0]
- Updated dependencies [e0d2f7e]
- Updated dependencies [95f1980]
- Updated dependencies [2b2e906]
- Updated dependencies [13afc8a]
- Updated dependencies [1331bfc]
- Updated dependencies [04be9ec]
- Updated dependencies [2525712]
- Updated dependencies [e7c3564]
- Updated dependencies [a549b95]
- Updated dependencies [75d2aa9]
- Updated dependencies [420ab8e]
- Updated dependencies [206f295]
- Updated dependencies [e99009a]
- Updated dependencies [38f71de]
- Updated dependencies [952c222]
- Updated dependencies [ee4c781]
- Updated dependencies [0c71158]
- Updated dependencies [4b3f571]
  - @psyche/protocol@0.3.0-alpha.0
