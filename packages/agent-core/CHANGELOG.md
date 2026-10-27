# @psyche/agent-core

## Unreleased (pre-0.3.0)

### Minor Changes

- T4 code plugins: agent-core's `AgentPluginRegistry` (context, before_tool_call, after_tool_call, agent_end, evaluate), `@psyche/plugins` (manifest, skill trust card install, one permission-restricted Node process per plugin) and the Gateway's `plugins.*` methods behind the `plugins.enabled` setting (off by default).
- E12 "From your other chats": turn context providers in the loop; the Gateway keeps digests of the owner's chats and, with `threads.otherChats` on, brings matching ones into a turn as untrusted context with a `related_threads` block in the reply (audited); `thread_read` asks on its first read of each chat.
- C10: a Claude Code harness behind `harness.delegate`. The `claude` CLI runs headless in its own sandbox (repo mounted, network only to the Anthropic API, key from the vault per session) and every tool call it makes asks Psyche first through a `PreToolUse` hook relay; edits ask as `file_write`, commands as `exec`, pushes as `git_push`. Harness actions can now name their approval kind. Registered only with the `harness.claudeCode` setting; Codex and pi are stubs.
- Context usage per chat (exact prompt tokens with a breakdown), owner-set limits (thread → settings → model; never exceeded) and structured auto-compaction that keeps the plan, with `threads.contextUsage`, `threads.setContextLimits`, `threads.compact` and `thread.context.updated`.
- Agent-proposed skills (T3): routine detection over the loop's in-process hooks, redacted and rate-limited skill drafts that install only through the T2 trust card, and the "Suggested by" card in Settings → Skills.
- Learning about the owner (#509): agent-core's `onOwnerTurn` hook; memory's dated Learned section in USER.md (`learnUserFacts`, `forgetLearned`) behind the sensitive and instruction filters; the Gateway's `memory.userProfile` switch, utility-model evaluator, `learned` chat note, audit entries and `memory.forgetLearned`.
- Stream reasoning steps as `chat.reasoning` (#632): the loop turns the model router's reasoning deltas into redacted, transient steps (setting `agent.showReasoning`, default on) and the Gateway publishes them without persisting them.
- Background specialists, part 1 (#683): `specialist.spawn`, `specialist.report` and `specialist.status`; specialist runs with their role's prompt, model, tool allowlist and clamped mode; the Specialists prompt section; `tasks.specialist` storage with `updateSpecialist`; the Gateway's specialist host (roles from the role skills and Settings, a subagent thread and task per job, one sanitized result).
- Voice turns (V-G G2, #691): the Gateway mounts the voice conversation over the chat path (spoken messages stored with `via: "voice"`, off until Settings turns it on), agent-core adds the voice-turn prompt section and the `voice` model role, tool steps are narrated from fixed labels, and `messages.via` is stored.
- Background specialists, part 2a (#683): a dedicated specialist pool (`specialists.maxConcurrent`, default 3, at most 2 per parent thread) with queue positions; the chat pool no longer claims specialist jobs; `ClaimOptions` origin and per-parent filters; the spawn pre-flight stored on `SpecialistSpec` and returned on `SpecialistJob`.
- Background specialists, part 2b (#683): per-job budget accounting with an 80% marker; at a limit an attended job pauses on a "Budget" question (finish, give it more, stop) and an unattended one writes its partial report; deadlines; the tool-free wrap-up turn; plan-first jobs; `raiseSpecialistBudget` for `tasks.update`.
- Remove all text-to-speech from the Gateway side: synthesis in `@psyche/speech` (Kokoro, ElevenLabs, read-aloud, voice catalog, the voice conversation manager), the voice-turn prompt section and `StartTurnInput.voice`, channel voice-note sending, and the synthesis half of the `SpeechEngine` contract. Speech to text is unchanged. The Gateway removes the stale voice and synthesis settings on start (`deleteSettings` in `@psyche/db`).
- Attach files in the chat composer. A + button shows when the thread's model can take files (from `models.list`; unknown shows it, a model without vision is offered documents only and says why an image was refused, an embeddings model hides it). Picked, dropped or pasted files become removable chips that upload through the new chunked `library.upload` (25 MiB, origin `upload`), and their Library ids go in `chat.send` `attachments`. The Gateway gives the agent images as image parts (4 per message, 5 MB each) and PDF, DOCX, XLSX and text files as capped extracted text (32k characters each, 96k per message) in the new `TurnInput.attachmentText`, kept out of what the owner said.

### Patch Changes

- The loop's `compaction` option (`thresholdRatio`, `keepRecentTurns`) applies again when the owner set no context limits, so the memory flush before compaction runs where it is configured.
- Run trace T1, part 3 (#660): task, automation and specialist turns are recorded through the run-trace sink (`TaskWorkerPoolOptions.trace`); automation runs name their agent run and usage; memory writes name their run and step; computer-use screenshots become run frames.
- When the canvas tools are registered the tools section carries one short output-guidance paragraph: canvas for substantial output, small update ops, one line in chat, tables as data.

## 0.3.0-alpha.0

### Minor Changes

- 81ca2c2: Agent runtime: the loop (steer / follow-up, hooks, budgets, cancellation), tool registry, context assembly with budgets and markers, compaction with the memory flush, permission path with taint, `ask_user`, plan mode, checklist, wrap-up, unattended contract, composer commands and `explainContext`.
- 0781486: Evaluator (C7): task runs with receipts are checked against the goal before they can end done; failed receipts reopen the run, uncertain ones and unverifiable results escalate to the owner.
- c41dfde: Harness plugin seam (C10): `HarnessPlugin` / `HarnessRegistry` and `harness.delegate`; every action of an embedded coding harness passes the Permission Broker with the same approval cards and gets a receipt.
- 5dcf208: Standing grants reach connector executors: the loop puts what authorized a dispatch (approval or standing grant, binding hash, scope) on `ToolRunContext.authority`, and the connector registry confirms a grant the way it confirms an approval. The sender of a channel turn travels as `StartTurnInput.requester` into `PermissionBroker.decide` and the approval card's context. Taint persists across kill/restart: `tool_call` events carry the persisted details, thread state keeps the taint sources, and tasks carry `taintSources`.
- 7f40b18: `notify` says "Notify the owner: …" (not "Notified") and a per-Task notify budget (`notifyBudget`, default 3) stops a run that loops on it: past the budget the loop asks once (a deferred card in an unattended run) and blocks further calls while that card waits (#307).
- 6a7b799: Subagents (C6): `subagent.spawn` with fork / fresh context, no question, messaging, approval or spawn authority, taint carried both ways, shared budgets and parent cancellation.
- 42dd7bd: Tools whose spec says `descriptionProvenance: "untrusted"` (MCP servers that are not bundled) taint the turn they are offered in, one `tool_description` source per server, and the system prompt's tools section marks them and frames their descriptions as data, not instructions (#281).
- e4e6f97: V10 coding helper: `code.open`, `code.search`, `code.read`, `code.edit` (unified diffs), `code.run` (sandbox with the repository bind-mounted, `.git` read-only) and `code.git` (host git without hooks; pushes behind a `git_push` card, once only). The Gateway composes the tools after the sandbox part; the scenario Stack takes real tool registrations.

### Patch Changes

- a43a514: The broker's per-app computer-use tier check keys on the described action: the loop passes `ToolCallDescription.meta` to the broker, and `computer.act`, `apps.open` and `apps.focus` name their action, so a `click` tier (and the terminal/IDE click cap) lets the agent click but not type. A `meta.app` that differs from the app target is denied.
- 7ac975c: `task.start` is a `write` with its own `task_start` approval kind (#48, review design-08): agent-core declares it, the broker infers it and titles the card "Start background task", chat cards say "Start a background task".
- cf3c922: Write-ahead dispatch (#63): the loop awaits `StartTurnInput.beforeDispatch` before every dispatch and `TaskWorkerPool` commits the step's `running` checkpoint there, so a crash never re-sends an applied effect. Restart re-issue (#64): a recovered Task turn waits on the card `reissue()` issued for the same call instead of showing the owner a second one. The resumability tests now assert both fixes.
- 2463dc3: The loop freezes a call's arguments at the gate (structuredClone before hashing), recomputes the binding from the live arguments before `verifyBinding` and again immediately before dispatch, and denies with `binding_mismatch` when they changed; executors, hooks and records get copies of the gated arguments (#70).
- e3ef188: The loop forwards `describeCall().connectorRule` and the turn's taint sources to the broker; the broker applies the connector matrix from `ToolCallIntent.connectorRule` and fills `ApprovalRequest.taintSources` (#71).
- e87d482: MCP grants made from the agent loop name their server and `tools/list` hash, so `revokeMcpGrants` revokes them on a listing change and an A→B→A change no longer revives them (#279). `describeMcpCall` uses the broker's `argsSha256` field name.
- 4f74993: P9 file tools get a package (#49): `@psyche/files` ships `read_file`, `write_file`, `edit_file`, `list_dir` and `search_files` with symlink, traversal and granted-folder refusal, size caps and paging, atomic writes, exact-match edits with conflict detection, and write provenance. `ToolCallDescription` gains optional display-only `details`, which the agent loop puts on the approval card (the `file_write` card's diff). The Gateway registers the package in place of INT-1's stand-in.
- 89f4815: Tool input schemas are always a top-level object (#414): a union of variants (`code.git`'s operations, `memory`'s commands) is advertised as one object with an enum discriminator and still validated per variant. Anthropic refused every request that offered `code.git`.
- a49d8b1: Binding recipes hash the exact strings that run or are sent: no NFC folding in the loop's or the connectors' canonical JSON, or in the Gmail send binding (S23 design-13).
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
