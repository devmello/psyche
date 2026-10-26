# The teaching loop: Psyche learns from you, and shows it (2026)

**Owner:** E (agent sheet, Soul & Memory, Settings). **Status:** spec, 2026-10-25. **Issues:** epic #676; T0 protocol #678, T1 Gateway #679, T2 UI #680, T3 dreaming and skills #681. **Asked by:** the owner ("Implement the teaching loop, and for the teaching loop mark improvements to memory. It should be clear how the agent has grown for you over time.").

Research behind this plan, with sources and dates: [research/teaching-loop.md](research/teaching-loop.md).

Companions:
- [docs/memory/people-and-projects-2026.md](../memory/people-and-projects-2026.md) (S07, PR #659, epic #649): the people and projects graph. Corrections about people and projects go through its versioned write path (§5.4, §6.1 there).
- [docs/design/redesign-2026.md](../design/redesign-2026.md): the visual language the new surfaces follow (grouped rows, level-1 cards, the agent sheet).
- [docs/copy/voice.md](../copy/voice.md): the two voices and the copy rules used in §8.

**The short version:**
- Psyche already learns: USER.md's dated Learned section (#509), MEMORY.md curated by dreaming with source lists, skill drafts from repeated routines, the Feed's interest ledger, and the Ideas acceptance model.
- But it learns **silently and only from what the owner says about themselves**. There is no way to say "not like this", nothing shows where a fact came from, and nothing shows change over time. Three pieces that exist are not wired: dreaming is not scheduled in the Gateway, the "Learned: …" chat note with Undo has no renderer, and `memory.userProfile` has no Settings control.
- This plan adds one loop:
  1. **Feedback** on every answer and action: explicit (helpful / not like this / a one-line correction) and implicit (undo, a heavy edit of a draft, a denied or edited approval, a dismissal).
  2. **Lessons**: each piece of feedback the agent acts on becomes a lesson record with its source, confidence and the value it replaced.
  3. **Routing**: the lesson is written where it belongs (tone → `SOUL.md`, facts → `USER.md`, people and projects → the graph, approach → the skill, parameters → the automation), through the existing protected-write paths.
  4. **Marks**: every changed entry carries "Learned from you · 25 Oct", "Refined 3 times", and a diff against the previous version.
  5. **Growth**: a timeline in the agent sheet of what was learned and what got better, with a weekly "What I learned" Feed card to accept, edit or forget.
- Everything is explicit and inspectable. Nothing is learned from content the owner didn't write, nothing is learned in incognito threads, and every lesson can be forgotten.

---

## 1. Where we are (main, 2026-10-25)

| Piece | What it does today | Where | Gap for the teaching loop |
| --- | --- | --- | --- |
| **USER.md auto-learning** (#509) | After each owner-authored turn the utility model proposes up to 5 durable facts; memory filters (secrets, ids, health, instruction-like text) and dedupes them, then writes `- YYYY-MM-DD [lf_… thread:<id> <kind>] text` under "## Learned (dated; from your chats)". Undo: `memory.forgetLearned`. | `apps/gateway/src/compose/user-profile.ts:154-189`, `packages/memory/src/learned.ts`, `store.ts:601-641` | Learns only from self-statements, never from corrections. The `learned` chat block has no renderer, so there is no visible note or Undo. `memory.userProfile` (`enabled`, `review: auto \| ask`) has no Settings control. |
| **Dreaming** | Deterministic nightly curation of MEMORY.md from 14 days of daily notes: groups, scores, merges, decays, writes source lists `[YYYY-MM-DD, …]`, never touches owner bullets, remembers deleted bullets, writes a diary to DREAMS.md. | `packages/memory/src/dreaming.ts`, `nightly.ts` | **Not scheduled**: `ensureDreamingAutomation` / `withDreaming` are only called from tests. It knows nothing about lessons. |
| **Claims** | `memory_claims` with kind, provenance, confidence, sources, `superseded_by`, `retracted_at`; `memory.claims.list / confirm`, `memory.explain`, `memory.forget`. | `packages/db/src/schema-s07.ts`, `packages/memory/src/store.ts:973-1100` | No UI lists claims, explains them or confirms them. |
| **Protected files** | SOUL, IDENTITY, USER, MEMORY, AGENTS. Agent writes need a single-use `memory_protected_write` approval; owner and job writes pass; untrusted is always denied. | `store.ts:662-687`, `support.ts:59-90`, `permissions/src/engine.ts:453` | The right gate for lesson write-back; no change needed. |
| **Skills** | `SKILL.md` + `acceptance.md` (a human-run script). Drafts from repeated routines (T3), accept / edit / dismiss. | `packages/skills/src/drafts.ts`, `agent-core/src/routines.ts` | No feedback on installed skills; nothing updates a skill from use. |
| **Feed and Ideas feedback** | `feed.feedback` (like, save, not interested, hide source, follow topic) writes the interest ledger; idea dismiss reasons train an acceptance model. | `proactive/src/feed/ledger.ts`, `proactive/src/ideas/acceptance.ts` | Already a working teaching loop for two surfaces; the new loop records them as feedback events too, so Growth can show them. |
| **Approvals** | approve / deny plus a scope; `audit.friction` reports ask and answer rates. | `schemas/permissions.ts:139-148` | No "approved without change" vs "edited before approving" signal. |
| **Receipts and the step log** | Receipts record every external write; the step log (#630, #635) shows a run's steps while it works and is never persisted. | `packages/audit/src/receipts.ts`, `packages/ui/src/chat/RunStepLog.tsx` | Receipts give outcomes per skill and per task; the step log is the place to attach "not like this" to a step. |
| **Graph** (S07, in progress) | People and projects with versioned facts and edges; `memory.entities.facts.set / retract`, `.edges.set / retract`, `memory.entities.history`; `source: { kind: "owner_edit" \| "owner_feedback" \| "chat", ref? }`. | `docs/memory/people-and-projects-2026.md` §5.4, §6.1 (#649–#653) | The teaching loop writes through it with `source.kind: "owner_feedback"`, `ref: "lesson:<id>"`. |

---

## 2. What people want, and what the reference products teach

The full notes are in [research/teaching-loop.md](research/teaching-loop.md). The design rules that follow from them:

What the products and papers show, condensed (each rule cites the section of the research notes):

1. **The industry moved from silent memories to explicit, editable rules.** Cursor removed auto-generated memories in 2.1 and asked users to turn them into rules files; Windsurf now recommends rules over memories; ChatGPT rebuilt its saved-memory list in June 2026 because entries went stale and contradicted each other (research §1, §4). → Lessons are discrete, typed, one-line entries with ids, written into files the owner can read and edit, never a summary blob.
2. **Name every write at the moment it happens, and link to the entry.** ChatGPT's inline "Memory updated" notice is the most copied pattern (§1). → "Psyche will remember: …" under the message, with Undo and Change.
3. **Provenance has to resolve to a real event.** GitHub Copilot Memory cites the evidence for every stored fact and re-checks it before use; Gemini shows source chips on personalised answers and admits its labels are sometimes wrong (§3, §4). → Every lesson points at the feedback event, thread and date it came from; "why" is never a model-written explanation.
4. **Explicit beats implicit.** Implicit signals are noisy (WildFeedback, CIPHER's edit-based learning works only with careful aggregation) (§7). → Explicit corrections write; undo, heavy edits and dismissals only *propose*, through the weekly card.
5. **Learning from approval causes sycophancy.** OpenAI's May 2025 post-mortem traces GPT-4o's sycophancy partly to thumbs-up reward; a CHI 2026 study found memory profiles produced the largest rise in sycophantic agreement (§7). → "Helpful" never creates a lesson, and lessons govern form and process (style, format, steps, permissions, priorities), never factual conclusions.
6. **Memory poisoning is the top security risk.** SpAIware (2024) and MINJA (NeurIPS 2025) planted false memories through content the agent read or ordinary queries (§7). → Only the owner's own UI actions and messages can create, approve or edit a lesson; text the agent reads is data.
7. **Scope before you write.** Apple Photos' "Feature Less" asks *what* to show less of (a person, a day, a place); Granola separates a one-off fix from a template change (§4, §5). → "Not like this" offers scope chips (just this time · this person · this kind of task · always), defaulting to the narrowest.
8. **Disclose use at the point of use, and offer an escape hatch.** Gemini's "regenerate without personalization" is cheap and tests whether personalisation helps (§3). → A quiet "Used 2 lessons" chip on answers that applied lessons, and "Redo without lessons".
9. **Memories go stale.** Copilot deletes facts unused for 28 days; ChatGPT's stale list forced a rebuild (§1, §4). → Lessons track last applied and last confirmed; unused ones come back as "Still true?" in the weekly card instead of being silently deleted; a contradicting lesson names what it supersedes.
10. **Per-source consent and separate verbs.** Apple's per-app "Learn from this App"; Claude's Pause (no back-fill) vs Reset; ChatGPT's Temporary Chat (§2, §5). → Per-signal and per-surface learning switches, Pause learning distinct from Forget everything, incognito never teaches.
11. **Progress views that respect people compare you with your own past and explain every number.** Oura breaks a score into named contributors against your own baseline; Apple Fitness compares 90 with 365 days and says when history is thin (§6). → Growth compares the agent with its own past, every number opens into the lessons and events behind it, with "Not enough history yet".
12. **Avoid streaks, levels, rankings and personality labels.** Duolingo's streak and guilt nudges, Spotify Wrapped's "Listening Age"; GitHub removed streak counters in 2016 and weekend activity dropped, showing the counters drove behaviour (§6). → No streaks, XP, badges, levels, percentiles or comparisons; milestones are dated facts; growth is framed as the agent's competence, not the owner's diligence.
13. **Forgetting must be complete.** ChatGPT and Gemini warn that deleting a memory may not remove derived copies; GDPR Art. 17 and EDPB 28/2024 expect real erasure (§1, §3, §7). → Forget removes the lesson, its line and derived consolidations at once and leaves a tombstone so the same evidence can't recreate it; lessons stay in context, never in model weights.
14. **Sensitive categories and third parties.** Gemini avoids sensitive topics unless the user raises them; profiling rules apply to inferences about people (§3, §7). → Never infer health, politics, religion, sexuality or finances; lessons about named contacts are scoped and shown as such.

---

## 3. The model

Four records, all in the Gateway database, all local, all exportable with `memory.export` and erased with `memory.reset`.

### 3.1 Feedback events (`feedback_events`)

One row per signal, explicit or implicit. Feedback is evidence; it changes nothing by itself.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `fb_…` | |
| `kind` | enum | `helpful`, `not_helpful`, `correction`, `undo`, `draft_edited`, `approval_edited`, `approval_denied`, `dismissed`, `regenerated`, `feed`, `idea` |
| `target` | object | `{ type: "message" \| "tool_call" \| "task" \| "approval" \| "draft" \| "feed_post" \| "idea" \| "automation_run" \| "skill_run", id, threadId?, taskId?, skill?, automationId? }` |
| `text` | string \| null | The owner's one-line correction (≤ 500 chars), or the reason chip ("Too long", "Wrong tone", "Wrong facts", "Didn't do what I asked", "Should have asked first") |
| `detail` | object \| null | For implicit kinds: `{ editDistance, before: hash, after: hash }` for a draft; the scope and changed fields for an approval; the dismiss reason |
| `surface` | `desktop \| web \| channel:<id>` | Where it was given |
| `provenance` | `owner` | Always owner. Feedback is accepted only from the owner's own devices and the owner's identity on channels; a delegated person's or a group member's reaction is never feedback. |
| `lessonId` | `ls_…` \| null | Set when a lesson was made from it |
| `createdAt` | ISO | |

Implicit signals and their thresholds:
- **Undo** of an agent write (a learned fact, a sent draft recalled, a task cancelled within 30 s of starting, a file edit reverted from the Files pane) → `undo`.
- **A draft the owner edited before sending** (email, message, document reply): `draft_edited` when the normalised edit distance is ≥ 0.2 of the draft's length; smaller edits count as "sent as-is" for outcomes, not as feedback. The texts themselves are not stored in the event, only hashes and the distance; the draft and the sent version already live in the thread and the receipt.
- **An approval answered with a narrower scope than offered, or edited arguments** (where cards allow edits) → `approval_edited`; a denial → `approval_denied` with the card kind.
- **Redo** with an instruction ("shorter"; `chat.send` with `redo`, §7) → `regenerated` with the instruction as `text`.
- Feed feedback and idea dismissals keep their own tables and also emit a `feed` / `idea` event, so Growth sees them.

Nothing else is implicit. Reading time, scroll, dwell, typing cadence and app usage are never recorded: that is the profiling the owner did not ask for.

### 3.2 Lessons (`lessons`)

A lesson is what the agent concluded from one or more feedback events, and where it wrote it.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `ls_…` | |
| `kind` | enum | `style` (tone, length, format), `fact` (about the owner), `entity` (a person or project), `approach` (tool choice, steps, when to ask), `parameter` (an automation's schedule, target, threshold), `boundary` (something not to do) |
| `statement` | string | The lesson in one sentence, in Psyche's words: "Replies to Jane are short and start with the answer." |
| `scope` | object | `{ global }` or `{ skill }`, `{ automationId }`, `{ entityId }`, `{ connector }`, `{ recipient }` — where it applies |
| `destination` | object | Where it was written: `{ file: "SOUL.md" \| "USER.md" \| "AGENTS.md", section, lineId }`, `{ graph: { entityId, attribute \| rel, versionId } }`, `{ skill, path: "skills/<name>/LESSONS.md", lineId }`, `{ automationId, field }` |
| `previous` | string \| null | The value it replaced (the old line, the old parameter), for the diff and for undo |
| `value` | string | The new line or value as written |
| `sources` | array | Feedback event ids, with the thread and date of each |
| `origin` | `stated` \| `inferred` | Stated: the owner said it (a correction, a chip). Inferred: confirmed from implicit evidence. Shown in separate groups. |
| `confidence` | 0–1 | §3.3 |
| `status` | enum | `proposed` (waiting for the owner), `active`, `confirmed` (the owner accepted it, or it held through two more uses), `dormant` (unused and unconfirmed; out of the prompt), `superseded` (a later lesson replaced it), `forgotten` |
| `refinedCount` | int | How many lessons this one superseded on the same destination |
| `lastAppliedAt` | ISO \| null | Set when a run's prompt included it (§5.1 "Used") |
| `createdAt`, `confirmedAt`, `forgottenAt` | ISO | |

Lessons are never written for content that arrived from the network or from a non-owner sender, and never from incognito threads, so the existing provenance rule holds: nothing untrusted becomes owner memory.

### 3.3 Confidence

Simple, explainable, and shown to the owner as words, not numbers:

| Evidence | Confidence | Shown as |
| --- | --- | --- |
| An explicit correction ("say 'Hi Jane', not 'Dear Jane'") | 0.9 | "You told me" |
| "Not like this" with a reason chip, or a redo instruction | 0.6 | "From your feedback" |
| One implicit signal (a heavy edit, an undo, a dismissal) | 0.3 | not written; kept as evidence |
| The same implicit signal three times in 30 days, consistent direction | 0.5 | proposed in the weekly card as a question: "Noticed 3 times" |
| The owner accepts the lesson (weekly card, or the proposal) | 1.0 | "You confirmed" |

Rules:
- **Write threshold:** a lesson is written when confidence ≥ 0.6, which only explicit feedback reaches. Implicit signals never write on their own: they stay as evidence and surface in the weekly card as a question ("Should I keep replies to Jane short?"), and an unanswered question expires after two weeks rather than being accepted (research rule 4).
- **Ask before write** when the destination is `SOUL.md` or `AGENTS.md`, or the lesson is a `boundary`: the existing `memory_protected_write` card, with the diff. `USER.md` facts and graph corrections follow `memory.userProfile.review` (`auto` writes and shows the note with Undo; `ask` shows a card).
- **Ageing:** each lesson tracks `lastAppliedAt` and `lastConfirmedAt`. A lesson not applied for 60 days comes back in the weekly card as "Still true?"; one left unanswered there moves to `dormant` (kept in the file's history, out of the prompt). Dreaming flags lessons contradicted by later feedback (research rule 9).
- **Form, not truth:** a lesson may change how Psyche writes, works, asks and prioritises; it may not change what Psyche says is true about the world. The router refuses lessons phrased as an opinion about the world ("vaccines are …", "this stock will …"), so factual answers aren't bent toward what the owner seems to believe (research rule 5).
- **No learning from approval alone.** "Helpful" raises confidence in an existing lesson but never creates one: learning from approval rewards flattery (sycophancy), so praise only confirms what a correction taught.

### 3.4 Growth metrics (`growth.summary`, computed, not stored)

Computed from feedback events, lessons, receipts, tasks and approvals over a window (7 days, 30 days, all time):

| Metric | Definition | Why |
| --- | --- | --- |
| Lessons | learned / refined / confirmed / forgotten in the window | What changed |
| Corrections applied | corrections that became lessons, and where they went | Feedback goes somewhere |
| Drafts sent as-is | share of agent drafts sent with edit distance < 0.2 | The plainest "it writes like me" signal |
| Approvals without change | share of approval cards answered with the offered scope and no edits | It proposes the right thing |
| Task success per skill | done / (done + failed + cancelled by the owner) per skill, with the count | Skills get better |
| Repeat corrections | corrections on a destination that already has a lesson | The honest metric: should go down |
| Milestones | first week, first lesson, 10 lessons, 100 tasks, first automation, first skill from a routine, first month | Moments, not streaks |

Metrics are shown only with enough data (≥ 10 events for a rate), with the count beside every rate, and never as a score, level, streak or rank.

### 3.5 Retention and forgetting

- Feedback events: 180 days, then deleted (only the counts survive in the growth history, as weekly aggregates).
- Lessons: kept while their destination line exists; a forgotten lesson keeps only `{ id, kind, forgottenAt }` so it is never re-proposed (the same pattern as dreaming's deleted-bullet ledger and the graph's `graph_feedback`).
- **Forget a lesson** removes its line from the destination (restoring `previous` when there was one) and anything dreaming derived from it (MEMORY.md bullets with its `lesson:<id>` source, consolidated lines), marks the lesson `forgotten` with a tombstone so the same evidence can't recreate it, optionally deletes its source events, and audits `teaching.lesson.forgotten` (ids only).
- **Forget everything I learned** (Settings → Memory) forgets every lesson and deletes every feedback event; the files keep what the owner wrote themselves.
- `memory.export` adds `lessons.json` and `feedback.json`; `memory.reset` clears both tables.
- The audit log records ids, kinds and counts, never the feedback text.

---

## 4. Routing: where a lesson is written

The Gateway's lesson router turns feedback into a lesson and picks one destination. It runs once per feedback event, on the utility model, with the target's context (the message, the draft, the step, the card), and returns `{ kind, statement, scope, destination, value }` or "no lesson". The model proposes; deterministic rules check and write.

| Lesson kind | Example feedback | Destination | Write path | Gate |
| --- | --- | --- | --- | --- |
| `style` (global) | "Shorter. Answer first." | `SOUL.md` → `## How I write for you` (a new, lesson-owned section) | memory protected write | card with diff |
| `style` (scoped) | "To Jane, just 'Hi Jane'." | `USER.md` → `## Preferences` with scope `recipient: jane@…` (or the graph, when Jane is an entity) | `learnUserFacts` / graph | `memory.userProfile.review` |
| `fact` | "My flight is Thursday, not Friday." | `USER.md` → Learned (dated) | `learnUserFacts` (extended to take a lesson id and the replaced line) | `memory.userProfile.review` |
| `entity` | "Alice is Maya's teacher, not her coach." | the graph: `memory.entities.facts.set` / `.edges.set` with `source: { kind: "owner_feedback", ref: "lesson:<id>" }` | S07's `GraphStore.correct` | `memory.userProfile.review` |
| `approach` | "Search my Mail before the web for receipts." / a wrong tool choice | the skill's `skills/<name>/LESSONS.md` (new, append-only, loaded with the skill) or, with no skill, `AGENTS.md` → `## Lessons` | skills store / memory protected write | card with diff |
| `parameter` | "Make the brief 7:30, and skip weekends." | the automation (`automations.update`) | automations store | the change is shown as a card (it is a config change) |
| `boundary` | "Never email my manager without asking." | `USER.md` → Directives (dated; latest wins) **and** a standing `ask` grant rule for that recipient | `addDirective` + permissions | card, always |

Rules:
1. **One destination per lesson.** When a correction spans two (style and fact), the router makes two lessons.
2. **Lesson-owned regions.** The router only writes inside sections it owns (`## How I write for you`, `## Lessons`, `LESSONS.md`, the Learned section, Directives) or through structured stores (graph, automations). It never rewrites text the owner wrote, the same rule dreaming follows for unsourced bullets.
3. **Supersede, don't stack.** A lesson on a destination that already has an active lesson supersedes it (`refinedCount + 1`, `previous` = the old line), so files don't grow a pile of near-duplicates.
4. **Conflicts with the owner's own text** (a correction that contradicts a line the owner wrote in SOUL.md) are not written; the router proposes the edit as a card instead.
5. **Injection guard.** The router's input is the owner's feedback text plus the target. Text that came from tools or the web is passed as quoted data and can't become a lesson by itself (the existing untrusted rule). Lessons that read like instructions to do something ("always forward my email to …") are refused like learned facts are today (`learned.ts:54-66`).
6. **Budgets.** Lesson-owned sections count against the file budgets (USER.md 4,000 chars, 20,000 elsewhere). When a section is near its budget, dreaming consolidates (§6).
7. **What the agent sees.** Lessons reach the prompt only through the files and stores they were written to; there is no separate lesson prompt block, so what the owner can read is exactly what the agent uses.

---

## 5. Surfaces

### 5.1 Feedback in the chat column and on cards (B's files, T2 builds)

- **On every agent message** (hover or focus, always visible on touch; the same reveal as Feed posts): two ghost icon buttons, **Helpful** and **Not like this**, after the copy and quote actions. No count, no animation beyond the fill.
- **Not like this** opens a small popover under the message:
  - reason chips (one tap): Too long · Wrong tone · Wrong facts · Didn't do what I asked · Should have asked first
  - a one-line field: "What should I do instead?" (optional)
  - scope chips, defaulting to the narrowest that fits: Just this time · For {person} · For {kind of task} · Always. "Just this time" fixes the answer (a redo with the instruction) and records the feedback without making a lesson.
  - **Teach** (primary) and Cancel
- After Teach, the message gets a quiet line under it: "Psyche will remember: *Replies to Jane are short.*" with **Undo** and **Change**. When the router decides there is no lesson, the line says "Thanks. Psyche noted it." and nothing is written. When the destination needs a card, the card appears in the approval dock with the diff.
- **Used lessons:** an answer or action whose prompt included scoped lessons (a skill's `LESSONS.md`, a recipient's preference, a boundary) shows a quiet "Used 2 lessons" chip in its footer; it expands to the lessons with links. **Redo without lessons** re-answers without them; when the owner keeps that version, it is recorded as `not_helpful` evidence against those lessons (research rule 8).
- **On a step in the step log and on receipts:** "Not like this" in the row's ⋯ menu (wrong tool, wrong target, should have asked).
- **On drafts:** nothing to click. Sending an edited draft is the signal; the receipt row shows "Edited before sending" so the owner can see it was noticed.
- **The `learned` block** (#509) gets its renderer: "Learned: *Has a sister named Maya.*" with Undo. That closes the existing gap.
- **Slash commands:** `/teach <text>` (a correction to the last reply) next to `/remember` and `/forget`.

### 5.2 Marks in memory views (E's files)

Wherever a line or value came from a lesson, it carries a mark:
- **Soul & Memory file rows and the editor** (`SoulMemoryPanel.tsx`): a margin mark beside lesson-owned lines: a small dot with "Learned from you · 25 Oct" on hover and focus; "Refined 3 times" when `refinedCount > 0`. Activating it opens a popover:
  - the lesson statement
  - its sources (feedback dates, with "Open thread")
  - the diff against the previous value (red / green, the editor's Diff view)
  - **Keep** (confirms), **Edit**, **Forget**
- **The graph's entity cards** (S07's UI, #652): the same mark on attributes whose current version has `source.kind: "owner_feedback"`; "Refined n times" from `memory.entities.history`.
- **Skills** (Settings → Skills): a skill with a `LESSONS.md` shows "3 lessons from you" with the list.
- **Automations** (Upcoming): a parameter changed by a lesson shows "Changed from your feedback · 25 Oct" in the row's details.
- **MEMORY.md bullets** from lessons get the source `lesson:<id>` in their source list, which the editor renders as the same mark.

The mark is text plus a glyph, never colour alone; the popover is reachable by keyboard and named for VoiceOver ("Learned from you on 25 October, refined 3 times. Show details").

### 5.3 Growth (agent sheet, new tab; and Settings → Memory)

The agent sheet gets a fifth segmented tab, **Growth**, after Soul & Memory (the four existing tabs keep their order). It is the answer to "how has Wren grown for me?":

```
| Growth                                   [7 days | 30 days | All]   |
| This month: 6 lessons, 3 refined · Drafts sent as-is 82% (41 of 50) |
|                                                                     |
| 25 Oct  Replies to Jane are short and start with the answer.        |
|         From your feedback · SOUL.md · [Show change]                |
| 23 Oct  Receipts: search Mail before the web.                       |
|         You told me · inbox-triage skill · [Show change]            |
| 21 Oct  Morning brief at 7:30, weekdays only.                       |
|         From your feedback · Upcoming · [Show change]               |
| 19 Oct  ◆ First automation: Morning brief                           |
|                                                                     |
| What got better                                                     |
|   inbox-triage      tasks done 9 of 10 (was 6 of 10 in September)  |
|   Approvals without change   74% (was 61%)                          |
|   Repeat corrections         2 this month (was 5)                   |
```

- **Timeline:** lessons and milestones newest first, grouped by week. Each row: date, statement, provenance in words ("You told me", "From your feedback", "Noticed 3 times", "You confirmed"), destination, **Show change** (the diff), and ⋯ (Forget, Open thread).
- **What got better:** the outcome metrics of §3.4 with this period against the agent's own previous period (30 against the prior 30 days, or 90 against 365), counts always beside rates, "Not enough history yet" while thin. Every number opens into the lessons and events behind it, as Oura's contributors do. No charts in v1 beyond a sparkline per metric (static under reduced motion).
- **Stated and inferred** lessons are grouped separately in the timeline's filter ("You told me" / "Noticed"), as Raycast separates Profile from Memory.
- **Empty state:** "Nothing learned yet. Tell Wren when something isn't right and it will remember." (one sentence, no action, §5.10).
- **Settings → Memory** gets a "What Psyche learned" group linking here, so the view is also reachable without the sheet.

### 5.4 The weekly card (Feed)

Once a week (Sunday 18:00 by default, or with the first brief of the week), when there was at least one lesson or one open question, a Feed post of kind `growth`:
- Title: "What I learned this week" (agent voice).
- Body: at most seven items, a review queue rather than a celebration: new lessons with their "Because:" line, questions from implicit evidence ("Should I keep replies to Jane short?"), lessons proposed for retirement ("Still true? I haven't used this since August"), and conflicts dreaming found.
- Per item: **Keep** (confirms: confidence 1.0), **Edit** (opens the line in the editor sheet), **Forget**. Questions get **Yes, remember** and **No**.
- One "Open Growth" link at the end.
- No card in a week with nothing to say, and never a "you haven't taught me lately" nudge. Unreviewed questions expire after two weeks. Turned off in Settings → Memory.

---

## 6. Dreaming and skills

- **Schedule dreaming** in the Gateway (call `ensureDreamingAutomation` at compose time, as the comment in `proactive/src/jobs.ts:5` expects). This is a prerequisite and fixes an existing gap.
- **Consolidate confirmed lessons:** dreaming reads `lessons` and:
  - merges near-duplicate active lessons on the same destination into one line (keeping both as sources, `refinedCount` summed);
  - moves a scoped style lesson that applied across many recipients into the global "How I write for you" section — as a proposal (a card), never silently;
  - flags lessons contradicted by later corrections for the weekly card;
  - promotes lessons confirmed twice into MEMORY.md's Preferences with `lesson:<id>` sources, keeping USER.md and SOUL.md lean;
  - never touches owner-written lines, as today.
- **DREAMS.md** gets a "Lessons" paragraph per night: counts and destinations, never the text.
- **Skills learn:** `skills/<name>/LESSONS.md` is created by the first `approach` lesson for that skill, loaded with the skill (after SKILL.md), budgeted (2,000 chars), and listed in Settings → Skills. When a skill has three or more lessons, the Ideas miner proposes a skill update (an edited `SKILL.md` draft that folds the lessons in), through the existing draft flow (`skills.drafts.*`, replay, trust card). `acceptance.md` gets a line per folded lesson so the owner's acceptance run checks it.
- **Outcomes per skill:** receipts and tasks already carry the skill; `growth.summary` reads them.

---

## 7. Protocol (additive)

All new methods are additive. Owner-only (`operator.write` for writes, `operator.read` for reads); a device paired with a lower scope can't give feedback.

```
feedback.give      { target, kind: "helpful" | "not_helpful" | "correction", text?, reason?,
                     scope?: "once" | "person" | "task_kind" | "always" }
                   → { event: FeedbackEvent, lesson: Lesson | null, approval: ApprovalRequest | null }
feedback.list      { since?, kind?, targetType?, cursor? } → { events: FeedbackEvent[], next? }
feedback.delete    { eventId } → ok                       (the owner removes one signal)

memory.lessons.list    { status?, kind?, destination?, since?, cursor? } → { lessons: Lesson[], next? }
memory.lessons.get     { lessonId } → { lesson, sources: FeedbackEvent[], diff: { before, after } }
memory.lessons.confirm { lessonId } → { lesson }
memory.lessons.edit    { lessonId, value } → { lesson, approval?: ApprovalRequest }
memory.lessons.forget  { lessonId } → { lesson }           (restores `previous`)
memory.lessons.forgetAll { approvalId? } → { lessons: number, events: number }   (presence-gated, like reset)

growth.summary     { window: "7d" | "30d" | "all" } → { lessons: {...}, metrics: [...], milestones: [...], timeline: GrowthItem[] }
```

Additive fields on existing shapes: `lessonsApplied: LessonRef[]` on agent messages and task runs (the Gateway fills it when it assembles the prompt; the client never claims it), and a `redo?: { messageId, instruction?, withoutLessons? }` field on `chat.send` (the protocol has no regenerate method today): "Redo" re-answers the given message, with the owner's instruction or without lessons.

Events: `feedback.recorded`, `lesson.changed` (`{ lessonId, status }`), `growth.updated` (coarse, debounced). Implicit feedback is recorded by the Gateway itself (draft sends, approval answers, undo paths), never by the client claiming it.

New schemas: `FeedbackEvent`, `FeedbackTarget`, `Lesson`, `LessonDestination`, `GrowthItem`, `GrowthMetric`, `Milestone`, and `growth` as a `FeedPostKind`. New block: `taught` (the chat line "Psyche will remember: …" with the lesson id). New approval detail rows for `memory_protected_write` cards that come from a lesson ("Because you said: …").

---

## 8. Settings and copy

**Settings → Memory** (a new section, or the existing Data controls renamed "Memory and data"; D decides with the settings-window design):

| Row | Control | Default |
| --- | --- | --- |
| Learn from your chats | switch (`memory.userProfile.enabled`) | on |
| Ask before saving what it learns | switch (`memory.userProfile.review: ask`) | off |
| Learn from your feedback | switch (`teaching.enabled`) | on |
| Notice edits, undos and dismissals | switch (`teaching.implicit`), with a disclosure listing each signal (draft edits, undo, approval edits, dismissals) as its own switch | on |
| Learn from these surfaces | per surface: chat, email drafts, messages, calendar, Feed, Ideas, each connector (`teaching.surfaces`) | all on |
| Pause learning | switch (`teaching.paused`): nothing is read or written while on, and nothing is back-filled afterwards | off |
| Weekly "What I learned" card | switch (`teaching.weeklyCard`) | on |
| What Psyche learned | → opens Growth | |
| Forget everything I learned | destructive button, typed confirmation | |

**Copy** (Psyche's voice unless noted; sentence case; no exclamation marks; per docs/copy/voice.md):

| Where | Text |
| --- | --- |
| Message action | Helpful · Not like this |
| Popover | What should I do instead? · Teach · Cancel |
| Reason chips | Too long · Wrong tone · Wrong facts · Didn't do what I asked · Should have asked first |
| After teaching | Psyche will remember: *{lesson}* · Undo · Change |
| No lesson | Thanks. Psyche noted it. |
| Card (protected write) | Update how {agent} writes for you · Because you said: "{text}" · Save change · Not now |
| Mark | Learned from you · {date} · Refined {n} times |
| Provenance words | You told me · From your feedback · Noticed {n} times · You confirmed |
| Weekly card (agent voice) | What I learned this week |
| Weekly item actions | Keep · Edit · Forget · Yes, remember · No |
| Growth empty | Nothing learned yet. Tell {agent} when something isn't right and it will remember. |
| Milestone examples | First week with {agent} · First automation: {name} · 100 tasks done |
| Forget all (confirm) | Forget everything {agent} learned from you? Its notes, Soul and skills go back to what you wrote. Type "forget" to confirm. |
| Receipt line | Edited before sending |

Never: "smart", "AI learns", "personalised for you", levels, streaks, "Great job", confetti.

---

## 9. Plan: four workstreams

Order: **T0 first** (protocol), then T1 and T3 in parallel against fixtures, then T2 after T1's first PR. Every PR: fixture tests only, `vitest --maxWorkers=1`, typecheck only the changed packages, no local models, no Electron e2e.

### T0: protocol (one PR, first)

Brief:
> Add the teaching-loop shapes from docs/agent/teaching-loop-2026.md §3 and §7 to `packages/protocol`, additively: schemas `FeedbackEvent`, `FeedbackTarget`, `Lesson`, `LessonDestination`, `GrowthItem`, `GrowthMetric`, `Milestone`; methods `feedback.give / list / delete`, `memory.lessons.list / get / confirm / edit / forget / forgetAll`, `growth.summary`; events `feedback.recorded`, `lesson.changed`, `growth.updated`; the `taught` block; the additive `lessonsApplied` field on agent messages and task runs and `redo { messageId, instruction?, withoutLessons? }` on `chat.send`; `growth` as a Feed post kind; the setting keys `teaching.enabled`, `teaching.implicit` (object: one boolean per signal), `teaching.surfaces`, `teaching.paused`, `teaching.weeklyCard` in the settings registry with their defaults. Every param carries a one-line `description`. Add a CHANGES.md entry and a changeset, run `pnpm protocol:gen` and `pnpm protocol:check`. Touch only `packages/protocol/**`, its generated files, and the MockGateway's method table in `packages/ui/src/data/mock-gateway.ts` (fixture handlers returning the fixtures you add to `packages/ui/src/fixtures/`), so T2 can build against it. Title: `protocol: teaching loop (feedback, lessons, growth) (part of #678)`.

### T1: Gateway: feedback store, lessons and routing (one session)

Brief:
> You own the teaching loop's Gateway side in docs/agent/teaching-loop-2026.md §3–4: `packages/db` (a migration adding `feedback_events` and `lessons`, with the schema in `schema-s07.ts`'s neighbourhood), a new `packages/memory/src/teaching/` (router, writers, confidence, retention), and `apps/gateway/src/compose/teaching.ts` plus the handlers for T0's methods.
>
> 1. **Feedback:** `feedback.give` stores an owner-only event (reject delegated and group senders), runs the router, and returns the lesson or the approval card. Record implicit events in the Gateway where they happen: draft sent with edit distance (the send path's receipt), approval answered with a narrower scope or edited args, undo paths (`memory.forgetLearned`, task cancel within 30 s, Files revert), a redo with an instruction (`chat.send` `redo`), Feed feedback and idea dismissals.
> 1b. **Used lessons:** fill `lessonsApplied` on agent messages and task runs when the prompt is assembled (skill `LESSONS.md`, scoped USER.md lines, boundaries), update `lastAppliedAt`, and honour `redo.withoutLessons`.
> 2. **Router** on the utility model, with a fixed JSON reply shape, then deterministic checks (§4 rules 1–7): one destination per lesson, lesson-owned regions only, supersede with `previous`, refuse instruction-like or untrusted-derived lessons, budgets.
> 3. **Writers:** SOUL.md `## How I write for you` and AGENTS.md `## Lessons` via `memory_protected_write` cards with the diff; USER.md facts via `learnUserFacts` (extend it to take the lesson id and the replaced line); Directives via `addDirective` plus a standing ask rule; the graph via S07's `GraphStore.correct` / `memory.entities.facts.set` with `source: { kind: "owner_feedback", ref: "lesson:<id>" }`; automations via `automations.update` as a card; skills' `LESSONS.md` via the skills store.
> 4. **`growth.summary`** from events, lessons, receipts, tasks and approvals (§3.4), with the minimum-data rule.
> 5. **Retention, forget, export and reset** (§3.5); audit ids and counts only.
> 6. **Wire dreaming**: call `ensureDreamingAutomation` at compose time.
>
> Tests on fixtures with the fake model provider: routing per kind (a table test of the §4 examples), the gates, supersede and refinedCount, injection refusals, owner-only feedback, undo restoring `previous`, retention, export and reset, growth metrics with small and empty data. No live models. Title: `feat(gateway): teaching loop store and routing (part of #679)`.

### T2: UI: feedback, marks, Growth, the weekly card (one session, after T1's first PR)

Brief:
> You own the teaching loop's UI in docs/agent/teaching-loop-2026.md §5 and §8 in `packages/ui`. Build against T0's MockGateway fixtures.
>
> - **Chat** (coordinate the two hunks with B: `chat/MessageView.tsx` actions and `chat/RunStepLog.tsx` row menu): Helpful / Not like this on agent messages (the Feed's hover reveal), the popover with reason chips and the one-line field, the `taught` block with Undo and Change, the `learned` block renderer (#509's missing note with Undo), the scope chips, the "Used n lessons" chip with Redo without lessons, "Not like this" in step-log and receipt ⋯ menus, `/teach`.
> - **Marks** (`agent/SoulMemoryPanel.tsx`, the Markdown editor's margin through the editor slot, Upcoming rows, Settings → Skills): the "Learned from you · date · Refined n times" mark and its popover with the diff, Keep, Edit, Forget.
> - **Growth tab** in `agent/AgentSheet.tsx` (a fifth segmented tab; `agentSheetRoute` accepts `growth`), the timeline, What got better, empty and error states per redesign §5.10.
> - **Weekly card:** the `growth` Feed post kind in `screens/feed/FeedPostCard.tsx` with Keep / Edit / Forget / Yes, remember / No.
> - **Settings → Memory rows** (§8) with D: the switches, the link to Growth, and Forget everything I learned.
>
> Every string through `t()` (keys in `messages/screens.ts` and `messages/chat.ts`), copy from §8. Stories for every surface in populated, empty, loading, error, dark and compact; tests on the MockGateway. Typecheck `@psyche/ui` only; regenerate only `Agent/Sheet` and your new story titles' baselines with `--workers=1`. Title: `feat(ui): teaching loop surfaces (part of #680)`.

### T3: dreaming and skills (one session, after T0)

Brief:
> You own docs/agent/teaching-loop-2026.md §6 in `packages/memory/src/dreaming.ts`, `packages/skills` and `packages/proactive`:
> - dreaming consolidates lessons (merge near-duplicates, propose global style moves as cards, flag contradicted lessons, promote twice-confirmed lessons into MEMORY.md with `lesson:<id>` sources), and writes the Lessons paragraph to DREAMS.md (counts only);
> - skills load `skills/<name>/LESSONS.md` after SKILL.md, with a 2,000-char budget; the Ideas miner proposes a skill update when a skill has three or more lessons, through `skills.drafts.*` (replay and the trust card), adding a line per folded lesson to `acceptance.md`;
> - the weekly `growth` Feed post (Sunday 18:00 or the week's first brief, only when there is something to say), from `growth.summary` and open low-confidence evidence.
>
> Deterministic tests on fixtures (lessons in, MEMORY.md / LESSONS.md / Feed post out), the existing dreaming invariants still hold (owner lines untouched, deleted bullets never re-promoted, loss cap). No live models. Title: `feat(memory): dreaming and skills learn from lessons (part of #681)`.

### What each workstream must prove before its last PR merges

| Workstream | Proof |
| --- | --- |
| T0 | `protocol:check` clean; MockGateway handlers and fixtures for every method |
| T1 | table tests for every §4 row; gates; owner-only; injection refusals; undo and forget restore `previous`; growth metrics on empty and small data; dreaming scheduled |
| T2 | MockGateway tests for feedback, marks, Growth and the weekly card; A12 clean; axe on every story |
| T3 | dreaming invariants plus lesson consolidation; LESSONS.md budget; skill-update draft replay; the weekly card's "nothing to say" week |

---

## 10. Risks

- **Silent profiling.** The fix is the rule set: only owner feedback, no behavioural telemetry beyond the five implicit signals, every lesson visible with its source, Settings switches, and forget per lesson and for everything.
- **Learning the wrong thing** from one bad day. The confidence table, the write threshold, the weekly card's questions, and superseding instead of stacking keep it reversible; Undo is one tap.
- **Sycophancy.** "Helpful" never creates a lesson; outcome metrics (drafts sent as-is, approvals without change, repeat corrections) measure usefulness rather than approval.
- **Memory poisoning.** Lessons come only from the owner's own words and actions; untrusted text is data to the router; instruction-like lessons are refused; protected files keep their cards.
- **Prompt growth.** Lesson-owned sections are budgeted and consolidated by dreaming; skills' lessons load only with the skill.
- **Shared contexts.** Delegated personas and group channels never receive MEMORY.md today; lessons in SOUL.md apply to the persona everywhere, so style lessons with a recipient scope stay scoped.
- **Gamification creep.** No scores, streaks, levels or confetti; milestones are dated facts.
- **Dependency on S07.** Entity corrections wait for the graph (#650/#651); until then `entity` lessons fall back to USER.md's People section with a scope, and T1 migrates them when the graph lands.
