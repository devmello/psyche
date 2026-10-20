# @psyche/db

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
