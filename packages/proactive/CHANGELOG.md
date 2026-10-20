# @psyche/proactive

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
