# @psyche/db

## Unreleased (pre-0.3.0)

### Minor Changes

- Google connect flow (#505): `connectors.connect` answers at once with the pending consent page and finishes as `connectors.updated`; durable connector records (`connectors` table, `SqliteConnectorStore`) restored at boot; the owner's OAuth client from `connectors.google` in `config.json` or `PSYCHE_GOOGLE_CLIENT_*` (secret only as a vault placeholder). Guide: docs/guides/connectors-google.md.
- People and projects graph store (#651, part 1): graph migration and drizzle mirror, identifier normalisation and bulk-sender rules, GraphStore with allowlisted facts and relations, history, interactions as pointers, open loops, suggestions, merge/split, forget with blocklist, retention, status and export.
- Batch approvals (#670 W2): `broker.requestBatch` decides every call of a proposal, refuses anything above `write`, sends and device-only kinds, and issues one once-only `batch` card bound to the ordered calls; approving mints one approved child approval per call. `ProposalService` runs the broker's stored calls under those children with per-call results and a 30-second undo; `proposals.*` handlers and `proposal.updated` events; the `action_proposals` table.
- Run trace T1, Gateway sink (#660): `run_steps` and `run_frames`, one sink for chat and helper runs, `runs.*` with `psyche-trace+json` v1 and Markdown export, retention of thinking text (`data.reasoningRetentionDays`) and frames (`data.replayRetentionDays`), and redaction at write. `@psyche/browser` exports `redactUrl`.
- Event triggers (#670 W3): `kind: "event"` automations run on `publishEvent` with dedupe by source id, debounce coalescing, a daily run budget, a restart-safe queue, taint by source and durable cursors; Upcoming shows them and run-now replays the last events. A new-mail poller publishes `mail.received` from Apple Mail and Gmail every 10 minutes in active hours, only when something listens. The scheduler tables are rebuilt to allow the new kind without losing history.
- The teaching loop's store and routing (#679): feedback events and lessons in the Gateway database, the lesson router with deterministic refusals and one destination per lesson, writers for SOUL.md, AGENTS.md, USER.md, the people graph, skills' LESSONS.md and automations, `feedback.*` and `memory.lessons.*` in the Gateway, approval answers as implicit evidence, and nightly dreaming scheduled at compose time.
- The inbox digest (#670 W4): unread mail since the last digest, pre-sorted without a model (owner rules in `mail/RULES.md`, lookalike senders, automated, bulk, first-time senders), the rest classified on the utility model with a quoted reason or FYI, batch proposals to mark read and archive, the graph's due waiting-on loops shown at most twice, one Feed post and one notification a day (in-app only when nothing needs you). Feed posts persist `kind`, `refs` and `card`.
- Background specialists, part 1 (#683): `specialist.spawn`, `specialist.report` and `specialist.status`; specialist runs with their role's prompt, model, tool allowlist and clamped mode; the Specialists prompt section; `tasks.specialist` storage with `updateSpecialist`; the Gateway's specialist host (roles from the role skills and Settings, a subagent thread and task per job, one sanitized result).
- `lessonsApplied` on agent messages and task runs (teaching loop §5.1, #679): the Gateway reads each run's assembled prompt after it ends, records the live lessons it carried on the run's messages (or its task, accumulated across runs) and moves their `lastAppliedAt`. Additive columns `messages.lessons_applied` and `tasks.lessons_applied`.
- Meeting prep and post-meeting notes (#670 W6): a prep planner with one-shot runs at T − 2 h and T − 60 min (re-planned on moves, dropped on cancels, at most 4 notifications a day, recurring meetings with nothing new as one digest line), read-only sourced prep notes, and notes from a recording or transcript with decisions, action items as one reminders card or "they owe you" loops, and a recap that is only a draft. The notifier honours `NotifyInput.breakQuietHours`. New table `meeting_preps`.
- Run trace T1, part 3 (#660): task, automation and specialist turns are recorded through the run-trace sink (`TaskWorkerPoolOptions.trace`); automation runs name their agent run and usage; memory writes name their run and step; computer-use screenshots become run frames.
- Voice turns (V-G G2, #691): the Gateway mounts the voice conversation over the chat path (spoken messages stored with `via: "voice"`, off until Settings turns it on), agent-core adds the voice-turn prompt section and the `voice` model role, tool steps are narrated from fixed labels, and `messages.via` is stored.
- Canvas artifact version store: `artifacts` and `artifact_versions` tables, the `artifacts.*` methods (canvas writes are the user's), and the agent's `artifact.create / update / read` tools that return references instead of content (chat experience phase 2).
- Remove all text-to-speech from the Gateway side: synthesis in `@psyche/speech` (Kokoro, ElevenLabs, read-aloud, voice catalog, the voice conversation manager), the voice-turn prompt section and `StartTurnInput.voice`, channel voice-note sending, and the synthesis half of the `SpeechEngine` contract. Speech to text is unchanged. The Gateway removes the stale voice and synthesis settings on start (`deleteSettings` in `@psyche/db`).

## 0.3.0-alpha.0

### Minor Changes

- 75a0f80: Web passkeys (WebAuthn) for the server-mode web client: `passkeys.*` methods, `ApprovalAnswer.presence`, a per-device passkey store, and a `webauthn` presence verifier that counts toward the security-settings presence check once a passkey is registered.
- 8d1c739: Scheduler: SQLite automations with cron/interval/reminder schedules, timezone and DST handling, catch-up after sleep (missed ticks coalesced into one run), session targets, the unattended-run contract, delivery, heartbeat, watches with dedupe and backoff, Upcoming and automations.* handlers; db gains the automations, automation_runs and watches tables.
- f2761ef: Tasks: SQLite task engine (leases, checkpoints, uncertain steps, parking, Activity log), in-process worker pool driving AgentLoop turns, and tasks.* handlers; db gains the tasks, task_checkpoints, task_actions and input_requests tables.
- 9a0cd76: Per-sender grant matrices for designated persons: persona limits, tool lists, per-identity allow / ask / deny, grants that never cross requesters, and cards that never go back to the requester's own chat.
- 1cc7f5a: Permission Broker (policy engine, binding hashes, approvals, grants, classifier hook, API handlers) and the hash-chained audit log with receipts; tables for approvals, grants, policy rules and receipts.
- e3014c1: Memory dreaming (H6): nightly 03:00 consolidation through the scheduler, the only writer of MEMORY.md (scoring with recall tracking, dedupe, supersedes, decay, DREAMS.md diary); memory_recalls migration.
- 4876a72: Memory: workspace files, FTS5 + sqlite-vec index, memory tools, pre-compaction flush, imports, export and memory.* handlers (S07); memory index migration.
- 76bc9cc: Channels (S10): channel framework, OpenClaw-style authorization and pairing, routing by dmScope, approvals over chat, voice notes, WebChat and Telegram adapters, `channels.*` API handlers; `channels` and `identities` tables.
- 0ee0215: Agent tools for the proactive surfaces: `goals.list | propose | update_progress | add_checkin`, `ideas.list | accept | dismiss | snooze`, `feed.list | mark_read | explain`. Reads run without approval; proposals, acceptances and changes on the owner's behalf are `write` and ask, bound to their exact arguments; results with web or connector text are `untrusted`; non-owner turns are refused; a tainted turn's brief can no longer become a recurring automation prompt. psyched registers them in the loop's registry. A migration adds `feed_posts.read_at`.
- 031c829: Goals (O9) and the heartbeat budget (O2): the proactive tables' migration with its drizzle mirror; `GoalsService` with confirm-first inferred candidates, milestones, links and check-ins as system automations on the scheduler (one `reminder` per check-in, run in-process through `withProactiveJobs`); `goals.*` handlers and `goal.updated` events; `PROACTIVITY_BUDGET`, and a heartbeat launcher whose tasks carry a 5k-token budget. psyched wires it in `compose/proactive.ts`.
- ed58763: Ideas (O7, O8): nightly mining of repeated tool sequences (skill drafts, unverified), owner notes, goals and connector signals; suppression of accepted, dismissed and hidden-source patterns; a logistic acceptance model refit from accept / dismiss history; batched delivery windows with one notification; accepting creates a task card in the main thread, an automation with template text only, or a goal check-in. `ideas.*` handlers and `idea.updated` events; a migration adds the delivery columns. psyched wires mining at 02:30 and a 09:00 window.
- 06ae560: Unified search (FTS5 index, query language, grouped and permission-scoped results, event indexing, `search.query`) and the skills loader with install and trust (discovery, gating, prompt index, `skills_search` / `skills_read`, static scan, `skill_install` approvals, lock file, updates with diff); `skills` table migration.
- 94fe0da: Vault M1: SQLCipher store, key slots, items and refusals, CSV import, placeholder resolution, redaction, fill helpers, OAuth token store and `vault.*` handlers; `credential_meta` / `credential_uses` migration.

### Patch Changes

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
