# @psyche/proactive

## Unreleased (pre-0.3.0)

### Minor Changes

- The Feed reads the owner's free-text `feed/INSTRUCTIONS.md` before every batch and puts it in the rerank and post-writer prompts ahead of the `interests.md` lines (part of #614).
- Batch approvals (#670 W2): `broker.requestBatch` decides every call of a proposal, refuses anything above `write`, sends and device-only kinds, and issues one once-only `batch` card bound to the ordered calls; approving mints one approved child approval per call. `ProposalService` runs the broker's stored calls under those children with per-call results and a 30-second undo; `proposals.*` handlers and `proposal.updated` events; the `action_proposals` table.
- Event triggers (#670 W3): `kind: "event"` automations run on `publishEvent` with dedupe by source id, debounce coalescing, a daily run budget, a restart-safe queue, taint by source and durable cursors; Upcoming shows them and run-now replays the last events. A new-mail poller publishes `mail.received` from Apple Mail and Gmail every 10 minutes in active hours, only when something listens. The scheduler tables are rebuilt to allow the new kind without losing history.
- The inbox digest (#670 W4): unread mail since the last digest, pre-sorted without a model (owner rules in `mail/RULES.md`, lookalike senders, automated, bulk, first-time senders), the rest classified on the utility model with a quoted reason or FYI, batch proposals to mark read and archive, the graph's due waiting-on loops shown at most twice, one Feed post and one notification a day (in-app only when nothing needs you). Feed posts persist `kind`, `refs` and `card`.
- Drafts in the owner's voice and scheduling over email (#670 W5): a voice profile learned from the owner's own sent text (`mail/VOICE.md` and samples, resettable, nightly refresh off by default), reply drafts with highlighted commitments saved only through an approval card, and three free slots with an optional batch of tentative holds. New agent tools `mail.draft_reply` and `mail.propose_times` only propose.
- Meeting prep and post-meeting notes (#670 W6): a prep planner with one-shot runs at T − 2 h and T − 60 min (re-planned on moves, dropped on cancels, at most 4 notifications a day, recurring meetings with nothing new as one digest line), read-only sourced prep notes, and notes from a recording or transcript with decisions, action items as one reminders card or "they owe you" loops, and a recap that is only a draft. The notifier honours `NotifyInput.breakQuietHours`. New table `meeting_preps`.
- The mail and meeting jobs honour Settings → Mail & meetings: pause and read-only (no proposals), the digest's time, days and quiet mode, the follow-up wait and "show at most twice", the mail check cadence, prep lead and notice times and daily cap, and the meeting-notes switch, task app, recap draft default, consent line and cloud-summary permission. Schedules re-sync when a key changes, and an upgraded install gets the one-time Feed card (§7.5).

### Patch Changes

- Post-meeting notes in the Gateway: `meetings.notes.create` and Record meeting (`meetings.record.*`) on `MeetingNotesService`, with `VoiceMemoService` transcribing long recordings through the helper's `speech.transcribe_file`; meeting prep reads attendees and open loops from the people graph, and "they owe you" items become graph loops.
- Record meeting takes the owner's device microphone: audio pushed to the Gateway becomes a Library WAV that the file transcriber (the Mac helper's `speech.transcribe_file`, or any `PathTranscriber`) reads where it lies. It is available once a transcriber is online, only the capturing device may push, and a recording ends by itself when chunks stop or the device disconnects.

## 0.3.0-alpha.0

### Minor Changes

- 0ee0215: Agent tools for the proactive surfaces: `goals.list | propose | update_progress | add_checkin`, `ideas.list | accept | dismiss | snooze`, `feed.list | mark_read | explain`. Reads run without approval; proposals, acceptances and changes on the owner's behalf are `write` and ask, bound to their exact arguments; results with web or connector text are `untrusted`; non-owner turns are refused; a tainted turn's brief can no longer become a recurring automation prompt. psyched registers them in the loop's registry. A migration adds `feed_posts.read_at`.
- d09baa7: The Feed (O5, O6): the `interests.md` ledger with its feedback rules and undo, RSS/Atom, Hacker News and arXiv sources behind an injected fetch, clustering, recall × recency, a seeded-shuffle utility-model rerank, exploration slots and posts with mandatory citations; the daily brief and user briefings as scheduler automations run in-process; `feed.*` handlers and `feed.updated` / `feed.post` events. psyched wires it with sources from the `feed.sources` setting.
- 031c829: Goals (O9) and the heartbeat budget (O2): the proactive tables' migration with its drizzle mirror; `GoalsService` with confirm-first inferred candidates, milestones, links and check-ins as system automations on the scheduler (one `reminder` per check-in, run in-process through `withProactiveJobs`); `goals.*` handlers and `goal.updated` events; `PROACTIVITY_BUDGET`, and a heartbeat launcher whose tasks carry a 5k-token budget. psyched wires it in `compose/proactive.ts`.
- ed58763: Ideas (O7, O8): nightly mining of repeated tool sequences (skill drafts, unverified), owner notes, goals and connector signals; suppression of accepted, dismissed and hidden-source patterns; a logistic acceptance model refit from accept / dismiss history; batched delivery windows with one notification; accepting creates a task card in the main thread, an automation with template text only, or a goal check-in. `ideas.*` handlers and `idea.updated` events; a migration adds the delivery columns. psyched wires mining at 02:30 and a 09:00 window.
- 8ab7b0b: Goal watches (O3): `GoalsService.addWatch` / `removeWatch` link scheduler watch automations to a goal; they run only while the goal is active and show their last status on the goal's progress. psyched now gives the scheduler a guarded watch fetcher (watches previously failed with no fetcher). A simulated-day audit test checks every proactive producer against the budget together.

### Patch Changes

- Updated dependencies [428ec1e]
- Updated dependencies [a5cef4e]
- Updated dependencies [4f8dff6]
- Updated dependencies [a43a514]
- Updated dependencies [353afa9]
- Updated dependencies [2558bfe]
- Updated dependencies [7ac975c]
- Updated dependencies [cf3c922]
- Updated dependencies [2463dc3]
- Updated dependencies [e3ef188]
- Updated dependencies [e87d482]
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
- Updated dependencies [81ca2c2]
- Updated dependencies [0781486]
- Updated dependencies [c41dfde]
- Updated dependencies [5dcf208]
- Updated dependencies [7f40b18]
- Updated dependencies [89f4815]
- Updated dependencies [c840e75]
- Updated dependencies [6a7b799]
- Updated dependencies [42dd7bd]
- Updated dependencies [2607fc3]
- Updated dependencies [a49d8b1]
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
- Updated dependencies [e4e6f97]
- Updated dependencies [0c71158]
- Updated dependencies [4b3f571]
  - @psyche/protocol@0.3.0-alpha.0
  - @psyche/agent-core@0.3.0-alpha.0
