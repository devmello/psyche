# @psyche/permissions

## Unreleased (pre-0.3.0)

### Minor Changes

- Batch approvals (#670 W2): `broker.requestBatch` decides every call of a proposal, refuses anything above `write`, sends and device-only kinds, and issues one once-only `batch` card bound to the ordered calls; approving mints one approved child approval per call. `ProposalService` runs the broker's stored calls under those children with per-call results and a 30-second undo; `proposals.*` handlers and `proposal.updated` events; the `action_proposals` table.
- The broker now applies the owner's Settings → Connectors rules (Allow / Ask / Deny per action group) to connector tool calls (#747).
  - **Registry:** stamps each call with its group; connector-write receipts record the deciding rule.
  - **Broker:** allow → no card; ask → card; deny → refused, with a receipt.
  - **Hard floors:** sends, destructive, financial and device-only calls always ask.
  - **Shortcuts:** each shortcut's rule applies (off → denied, allow → no card).
  - **Gateway:** syncs `permissions.connectors.*` and `shortcutRules` into the broker policy and the executor's matrix. Direct Apple helper calls follow the same groups.

### Patch Changes

- Apple Mail tools, wave 1 (#639): mailboxes with unread counts, the selected email, reply and forward drafts, send a saved draft (bound to its recipients and body hash), mark read / flag, move or archive, save attachments.
- Apple Reminders and Calendar tools, wave 1 (#639): due-today / overdue / flagged / text filters, links, alarms and repeats on reminders, complete, flag and delete; event search with attendees and meeting links, alarms, recurrence and availability, free/busy, delete.
- Apple Notes tools, wave 1 (#639): search by text, folders, append (text or checklist), update bound to the note's previous body hash, Markdown create.
- Apple Contacts connector, wave 1 (#639): look people up by name, email, phone or company; read a contact; add people and add emails or phones (approval-gated). The Apple connector now supports other grants (Contacts, none) and non-Apple identities.
- Music connector (Apple Music and Spotify), wave 1 (#639): now playing, playback control, library search and play; the agent's playback tools are allowed by default (nothing leaves the Mac).
- Safari and Chrome connectors, wave 1 (#639): open tabs and the current tab, the text of a Safari page (untrusted), adding to Safari's Reading List; Chrome tabs.
- Files connector, wave 1 (#639): newest files in shared folders, move / rename (ask), put in the Trash (destructive, asks).
- Shortcuts connector, wave 1 (#639): list the owner's shortcuts; run one with text input and get its output (destructive, always asks; shortcuts the owner turned off never run).
- Things 3 connector, wave 1 (#639): list Inbox / Today / Upcoming / projects / areas / tags; add, reschedule and complete to-dos (ask).
- The teaching loop's store and routing (#679): feedback events and lessons in the Gateway database, the lesson router with deterministic refusals and one destination per lesson, writers for SOUL.md, AGENTS.md, USER.md, the people graph, skills' LESSONS.md and automations, `feedback.*` and `memory.lessons.*` in the Gateway, approval answers as implicit evidence, and nightly dreaming scheduled at compose time.
- Approvals by voice (V-G G3, #691): within chat's tiers (writes by default, never device-only or Touch ID approvals, deny-only in tainted turns), Psyche reads the broker's summary back, listens for a fixed phrase for 10 s and answers through the broker as the device's own card with scope `once`; the audit entry records `via: "voice"`.

## 0.3.0-alpha.0

### Minor Changes

- fa08fee: Restores no longer resurrect deleted vault items: removals go to the revocation ledger (`recordVaultItem`, `vaultItemIds`), and the vault (`VaultOptions.removals`) drops them from its mirror at start and from the encrypted store at every unlock.
- e83a19e: Auto-mode classifier evaluation set and gate (no unsafe label); the model-backed classifier never labels below a deterministic floor.
- 9a0cd76: Per-sender grant matrices for designated persons: persona limits, tool lists, per-identity allow / ask / deny, grants that never cross requesters, and cards that never go back to the requester's own chat.
- 4bc7113: Approval-friction metrics from the audit log: `frictionMetrics` in `@psyche/permissions` and the `audit.friction` method (`AuditFrictionResult`, `operator.read`) in the protocol.
- 1cc7f5a: Permission Broker (policy engine, binding hashes, approvals, grants, classifier hook, API handlers) and the hash-chained audit log with receipts; tables for approvals, grants, policy rules and receipts.
- 0d9d34d: Restoring a backup no longer brings back revoked devices or grants: revocations go to a ledger outside the backup that the Gateway replays at every boot, and a restore into a home without it un-pairs devices and revokes every standing grant (S23 design-26).
- 4d718e6: Action matrix for the mac helper's Apple app adapters (J6): `apple.<app>` connector keys with Allow defaults for reads, Ask for writes, and `mail.send` that always asks.
- e99009a: Skills install and trust (T2): `SkillManifest`, `SkillUpdateStatus`, `skills.checkUpdates`, the `skills.updated` event, and a dedicated device-only `skill_install` binding covering source, tree hash and the declared tools, approval kinds and prompt files.

### Patch Changes

- 428ec1e: `ApprovalKind` gains `apple_script` and `shortcut_run` (J4): scripts and Shortcuts run by the agent on the Mac get their own approval cards, offered `once` only.
- 81cf744: Approval, question and wrap-up cards render per surface through one function (`@psyche/permissions/cards`, review design-12): chat transports send `renderForSurface(surface, approval)` and show a device-only approval as "Answer this on your Mac." with nothing answerable; the UI kit's cards consume the desktop rendering from the same function, so the surfaces cannot drift.
- 1dc1561: Channel reply authority: evaluate the replying turn (requesting conversation, mode, deny rules, taint) and verify each iMessage `messages.send` against the approved binding at dispatch, with a receipt.
- a43a514: The broker's per-app computer-use tier check keys on the described action: the loop passes `ToolCallDescription.meta` to the broker, and `computer.act`, `apps.open` and `apps.focus` name their action, so a `click` tier (and the terminal/IDE click cap) lets the agent click but not type. A `meta.app` that differs from the app target is denied.
- 7ac975c: `task.start` is a `write` with its own `task_start` approval kind (#48, review design-08): agent-core declares it, the broker infers it and titles the card "Start background task", chat cards say "Start a background task".
- e3ef188: The loop forwards `describeCall().connectorRule` and the turn's taint sources to the broker; the broker applies the connector matrix from `ToolCallIntent.connectorRule` and fills `ApprovalRequest.taintSources` (#71).
- 2064c0c: An allowlisted (non-owner, non-designated) sender's turn gets no reads of the owner's sources (`requester:not_owner`); only `web_search` / `web_fetch` and no-effect calls remain (#293). The fake broker matches.
- 2be1a8a: An allowlisted sender's calls outside the route's `toolAllow` are refused (`requester:not_owner`), so chat-only routes (`toolAllow: []`, #321) get no tools at all (#293).
- 8e28cac: File tools never reach Psyche's own files (only `workspace/` and `library/` under `$PSYCHE_HOME`), SSH keys, CLI credentials or browser profiles, and never change protected memory files or workspace skills, whatever folder is granted (#285).
- e87d482: MCP grants made from the agent loop name their server and `tools/list` hash, so `revokeMcpGrants` revokes them on a listing change and an A→B→A change no longer revives them (#279). `describeMcpCall` uses the broker's `argsSha256` field name.
- 42496a0: Write+ tools of unknown-tier MCP servers ask (`mcp:unknown_tier`, `once` only) for `connector_action` calls too, which is how MCP calls arrive; an `mcp__` tool without a tier counts as unknown (#280).
- ecf0dd5: `notify` to the owner needs no card in any mode but plan, tainted or not (`owner_inbox`, #307); the fake broker matches.
- 412aaa1: Connector writes reach an approval card again: `mcp__` tools may describe their connector kind, and the connector registry confirms the loop's approval with the loop's binding recipe instead of consuming it a second time (#78).
- 1cf5421: Fuzz and property tests for canonicalization, decide(), grant TTLs, URL rules and the approval lifecycle; fixes found by them: unused `once` approvals end at a restart, and hosts with empty labels are not canonical.
- d74ccce: A tainted turn's read of an origin the owner already approved with a live standing grant is no longer escalated as a new origin (#69).
- e4e6f97: V10 coding helper: `code.open`, `code.search`, `code.read`, `code.edit` (unified diffs), `code.run` (sandbox with the repository bind-mounted, `.git` read-only) and `code.git` (host git without hooks; pushes behind a `git_push` card, once only). The Gateway composes the tools after the sandbox part; the scenario Stack takes real tool registrations.
- 0c71158: `ApprovalKind` gains `git_write` and `git_push` (V10 coding helper; a push is offered `once` only), and `SandboxRunner.ensureSandbox` takes optional `mounts` (bind mounts of granted host folders, fixed per scope).
- Updated dependencies [428ec1e]
- Updated dependencies [a5cef4e]
- Updated dependencies [4f8dff6]
- Updated dependencies [353afa9]
- Updated dependencies [2558bfe]
- Updated dependencies [7ac975c]
- Updated dependencies [09c0c6f]
- Updated dependencies [d982437]
- Updated dependencies [c4175a2]
- Updated dependencies [7f2b58f]
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
- Updated dependencies [1cc7f5a]
- Updated dependencies [0d9d34d]
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
  - @psyche/audit@0.3.0-alpha.0
