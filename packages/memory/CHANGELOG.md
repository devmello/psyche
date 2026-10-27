# @psyche/memory

## Unreleased (pre-0.3.0)

### Minor Changes

- Learning about the owner (#509): agent-core's `onOwnerTurn` hook; memory's dated Learned section in USER.md (`learnUserFacts`, `forgetLearned`) behind the sensitive and instruction filters; the Gateway's `memory.userProfile` switch, utility-model evaluator, `learned` chat note, audit entries and `memory.forgetLearned`.
- People and projects graph store (#651, part 1): graph migration and drizzle mirror, identifier normalisation and bulk-sender rules, GraphStore with allowlisted facts and relations, history, interactions as pointers, open loops, suggestions, merge/split, forget with blocklist, retention, status and export.
- People and projects graph (#651, part 2): card files with an owner-edit round trip (corrections, loops, notes, identifiers) and agent writes refused, and the deterministic ingester (Contacts, mail headers with thresholds and bulk/role/shared rules, the no-reply loop rule, calendar attendees, messages, owner-named projects), with the shared fixture world.
- People and projects graph (#651, part 3): the model pass with taint rules, budgets and caching; deterministic project assignment and suggestions; memory.entities.* / memory.loops.* / memory.graph.status handlers; the people_lookup, project_brief, waiting_on, meeting_prep and loop_update tools; entity recall for private sessions.
- The teaching loop's store and routing (#679): feedback events and lessons in the Gateway database, the lesson router with deterministic refusals and one destination per lesson, writers for SOUL.md, AGENTS.md, USER.md, the people graph, skills' LESSONS.md and automations, `feedback.*` and `memory.lessons.*` in the Gateway, approval answers as implicit evidence, and nightly dreaming scheduled at compose time.
- Teaching loop growth and retention (#679): `growth.summary` (outcomes against the agent's own previous window, counts with every rate, null rates below 10 events, dated milestones), 180-day feedback retention, `memory.lessons.forgetAll` (presence-gated), lessons and feedback in `memory.export` and `memory.reset`, and the remaining implicit signals (learned-fact undo, quick task cancels, redo instructions, Feed and Ideas feedback).
- Run trace T1, part 3 (#660): task, automation and specialist turns are recorded through the run-trace sink (`TaskWorkerPoolOptions.trace`); automation runs name their agent run and usage; memory writes name their run and step; computer-use screenshots become run frames.

## 0.3.0-alpha.0

### Minor Changes

- e3014c1: Memory dreaming (H6): nightly 03:00 consolidation through the scheduler, the only writer of MEMORY.md (scoring with recall tracking, dedupe, supersedes, decay, DREAMS.md diary); memory_recalls migration.
- 230b794: Git-friendly workspace (H10): WorkspaceGit sync to the owner's private repo with a generated .gitignore, remote validation, secret scan before commit, rebase-then-push and reported conflicts.
- 4876a72: Memory: workspace files, FTS5 + sqlite-vec index, memory tools, pre-compaction flush, imports, export and memory.* handlers (S07); memory index migration.
- 0a6f9d6: Persona editing by pencil (H9): memory.persona.get / memory.persona.edit handlers (natural language via the utility model, or fields), persona_update tool behind memory_protected_write, persona.updated with avatarRequested; classifyMemoryCall for every memory tool.

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
- Updated dependencies [8d1c739]
- Updated dependencies [f2761ef]
- Updated dependencies [9a0cd76]
- Updated dependencies [4bc7113]
- Updated dependencies [1cc7f5a]
- Updated dependencies [515b904]
- Updated dependencies [e3014c1]
- Updated dependencies [4876a72]
- Updated dependencies [f4cf9c0]
- Updated dependencies [e0d2f7e]
- Updated dependencies [95f1980]
- Updated dependencies [76bc9cc]
- Updated dependencies [2b2e906]
- Updated dependencies [13afc8a]
- Updated dependencies [1331bfc]
- Updated dependencies [04be9ec]
- Updated dependencies [2525712]
- Updated dependencies [0ee0215]
- Updated dependencies [031c829]
- Updated dependencies [ed58763]
- Updated dependencies [e7c3564]
- Updated dependencies [a549b95]
- Updated dependencies [06ae560]
- Updated dependencies [75d2aa9]
- Updated dependencies [420ab8e]
- Updated dependencies [206f295]
- Updated dependencies [e99009a]
- Updated dependencies [38f71de]
- Updated dependencies [952c222]
- Updated dependencies [ee4c781]
- Updated dependencies [0c71158]
- Updated dependencies [94fe0da]
- Updated dependencies [4b3f571]
  - @psyche/protocol@0.3.0-alpha.0
  - @psyche/db@0.3.0-alpha.0
