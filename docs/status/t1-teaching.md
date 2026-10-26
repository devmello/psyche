# T1 status: the teaching loop's Gateway side (#679)

Updated 2026-10-25. Spec: [docs/agent/teaching-loop-2026.md](../agent/teaching-loop-2026.md) §3–4, §9 "T1". Code: `packages/memory/src/teaching/`, `apps/gateway/src/compose/teaching.ts`, migration `packages/db/migrations/202610251600_memory_teaching.sql`.

## First PR: store and routing (#740, merged)

- **Records.** `feedback_events`, `lessons` (with `destination_key`, `fingerprint` for tombstones, `approval_id` for a pending card) and `feedback_weekly` (counts that outlive the events).
- **Feedback.** `feedback.give` takes owner-only feedback from a paired device. Delegated persons and groups are refused with `forbidden`. Incognito, paused or switched-off learning and switched-off surfaces get `policy_denied`. "Helpful" never creates a lesson; it raises the confidence of lessons the answer used (`Message.lessonsApplied`, filled in the second PR). Implicit kinds are evidence only. `feedback.list` and `feedback.delete` are mounted too; deleting a lesson's last source forgets the lesson.
- **Router.** The utility model sees the owner's words, the target quoted as data, and the lessons that already exist. It proposes a lesson, and deterministic rules check it (§4 rules 1–7). A lesson supersedes another only when the router names it and it sits on the same destination. Single-valued destinations always supersede. A repeat adds a source instead of a line.
- **Writers.** Every row of the §4 table has a writer:
  - SOUL.md `## How I write for you` and AGENTS.md `## Lessons`;
  - USER.md `## Preferences` and `## People`, as scoped tagged lines;
  - USER.md Learned, through `learnUserFacts` (now takes the lesson id and the replaced fact);
  - Directives, through `addDirective`, plus a standing `ask` rule in `permissions.policy` (only rules the loop added are ever removed);
  - the people graph, through `GraphStore.setFact` / `setEdge` with `source: { kind: "owner_feedback", ref: "lesson:<id>" }`;
  - `skills/<name>/LESSONS.md`;
  - automations, through `Scheduler.update`.
- **Gates.** SOUL.md, AGENTS.md, skills, automations and boundaries always get a `memory_protected_write` card with `fromLesson` and the line diff. USER.md and the graph follow `memory.userProfile.review`. An approved card is verified and consumed once. A declined card leaves the lesson `dormant`. Cards open at a restart are re-awaited (`resume`).
- **Lessons methods.** `memory.lessons.list / get / confirm / edit / forget`. Forget restores `previous`, makes the superseded lesson live again, removes MEMORY.md lines citing `lesson:<id>`, and keeps a tombstone.
- **Implicit evidence.** Approval answers with a narrower scope than offered (`approval_edited`) or a denial (`approval_denied`); lesson cards and plan approvals are skipped.
- **Dreaming** is scheduled by S07's `people` part on main (the dreaming automation runs dreaming and the graph pass), so T1 adds nothing there.
- **The chat note.** A `taught` block ("Psyche will remember: …") goes under the corrected message.

## Second PR: growth, retention and the remaining implicit signals

- **`growth.summary`** (§3.4) over the teaching tables, approvals, tasks, automations and the first thread. Every rate is null below 10 events, has its count and the previous window's figures, and opens into its evidence ids. Milestones are dated facts.
- **Retention.** Feedback is deleted after 180 days, checked at start and then on the Gateway's retention interval (daily by default); weekly counts stay.
- **Forget everything.** `memory.lessons.forgetAll` is presence-gated like `memory.reset` (`presence-gate.ts`). A dry run only counts.
- **Export and reset.** `memory.export` adds `lessons.json` and `feedback.json`; `memory.reset` clears both tables.
- **Implicit signals now recorded:**
  - undo of a learned fact (`memory.forgetLearned`, on the "Learned" note);
  - a task cancelled within 30 s;
  - a `chat.send` `redo` with an instruction (`regenerated`, routed at 0.6), through a new `GatewayContext.chatRedo` listener set;
  - Feed feedback and idea dismissals, mirrored once each.
- **Drafts.** `recordDraftSent` is ready (an outcome count, plus `draft_edited` at an edit distance of 0.2 or more), but no call site exists yet. No in-app path sends an agent draft today: the owner sends Gmail drafts in Gmail.

## Third PR: `lessonsApplied`

- Two additive migrations: `202610261000_gateway_messages-lessons-applied.sql` (S01's `messages`) and `202610261001_tasks_lessons-applied.sql` (S04's `tasks`).
- At `agent_end` the Gateway reads the run's assembled prompt (`explainContext`) and collects its lesson ids: the `[ls_…]` tags of lesson-owned lines and `lesson:ls_…` on learned facts. Live lessons among them become `LessonRef`s and their `lastAppliedAt` moves.
- A task's refs go on the task through `SqliteTaskEngine.setLessonsApplied`, accumulated across runs and capped at 20. A chat run's refs go on its agent messages once `run.updated` shows the transcript committed (`setRunLessonsApplied`), and the updated messages are re-published as `chat.message`.
- "Helpful" now has the lessons to confirm.

## Not done yet

- **`redo.withoutLessons`.** Blocked: `chat.send` `redo` is recorded but not acted on (nothing re-answers the message yet; S01 / T2). Once redo exists, the loop needs a context option that leaves out lesson-tagged lines.
- **A Files-pane revert as `undo`.** No revert path exists yet.

## Notes for other workstreams

- **T3 (skills):** `LESSONS.md` at the top of a skill folder is excluded from the skill tree (`packages/skills/src/tree.ts` `LESSONS_FILE`). A new lesson therefore never turns an approved workspace skill back into a draft, and a bundle can't ship one. When you load it with the skill, read only lines whose `[ls_…]` id is a live lesson for that skill. That way a file someone dropped there by hand is never prompt text.
- **S07 (graph):** entity and person-scoped style lessons use `GraphStore.setFact` / `setEdge` / `retractFact` with `owner_feedback` and `lesson:<id>`. The Gateway passes `people.graph`. A person or project the graph doesn't know falls back to USER.md People, scoped to the name.
- **Repo scan:** `docs/agent/research/teaching-loop.md` cites a help-center URL whose numeric article id the card pattern flags. It is allowlisted for `card` only in `check-secrets.ts`.
