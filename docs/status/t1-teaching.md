# T1 status: the teaching loop's Gateway side (#679)

Updated 2026-10-25. Spec: [docs/agent/teaching-loop-2026.md](../agent/teaching-loop-2026.md) §3–4, §9 "T1". Code: `packages/memory/src/teaching/`, `apps/gateway/src/compose/teaching.ts`, migration `packages/db/migrations/202610251600_memory_teaching.sql`.

## First PR: store and routing

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
- **Dreaming.** `ensureDreamingAutomation` runs at compose time and `withDreaming` wraps the task launcher, so the nightly run happens in-process.
- **The chat note.** A `taught` block ("Psyche will remember: …") goes under the corrected message.

## Second PR (next)

- `growth.summary` (§3.4) with the minimum-data rule.
- Retention (180 days) and `memory.lessons.forgetAll` (presence-gated).
- `lessons.json` / `feedback.json` in `memory.export`, and both tables cleared by `memory.reset`.
- `lessonsApplied` on messages and task runs, plus `redo.withoutLessons`.
- The remaining implicit signals: draft edits from the send path's receipt, undo (`memory.forgetLearned`, a task cancelled within 30 s, a Files revert), a redo instruction from `chat.send`, and Feed / Ideas mirrors.

## Notes for other workstreams

- **T3 (skills):** `LESSONS.md` at the top of a skill folder is excluded from the skill tree (`packages/skills/src/tree.ts` `LESSONS_FILE`). A new lesson therefore never turns an approved workspace skill back into a draft, and a bundle can't ship one. When you load it with the skill, read only lines whose `[ls_…]` id is a live lesson for that skill. That way a file someone dropped there by hand is never prompt text.
- **S07 (graph):** entity and person-scoped style lessons use `GraphStore.setFact` / `setEdge` / `retractFact` directly, and the Gateway passes a graph only once part 3 composes one (`TeachingComposeDeps.graph`). Until then, entity lessons fall back to USER.md People, scoped to the name.
- **Repo scan:** `docs/agent/research/teaching-loop.md` cites a help-center URL whose numeric article id the card pattern flags. It is allowlisted for `card` only in `check-secrets.ts`.
