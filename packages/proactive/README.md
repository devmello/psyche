# @psyche/proactive

**Owner:** S15 (`prompts/s15-proactive-notifications.md`). Feature ids: O2 (heartbeat budget), O5–O9
in [docs/03-feature-spec.md](../../docs/03-feature-spec.md). Architecture §2 principle 10 and
§4.11; ADR-012; data model §8.

Feed, Ideas and Goals: the proactive surfaces, bounded and confirmable. Everything proactive is
produced by scheduled jobs in batches, cites its evidence, can be dismissed, and never sends or
writes outside Psyche without an approval (an accepted idea becomes a Task that runs under the
Permission Broker).

## Status (M2, in order of the spec's dependencies)

| Slice | Feature ids | State |
| --- | --- | --- |
| Goals, check-ins, confirm-first candidates, `goals.*`, heartbeat budget | O9, O2 | **done** (PR 1) |
| Interest ledger, Feed pipeline, briefings, `feed.*` | O5, O6 | **done** (PR 2) |
| Ideas pipeline, acceptance model, delivery windows, `ideas.*` | O7, O8 | after the Feed |
| Goal watches, budget audit | O3 | last |

## Public API (`src/index.ts`)

- `PROACTIVITY_BUDGET`: every bound in one place (heartbeat 5k tokens and one notification per
  run; brief 5–10 posts with 1–2 exploration slots; ideas per window and the acceptance
  threshold; open goal candidates and one reminder per check-in). `HEARTBEAT_TASK_BUDGET` is the
  `TaskBudget` the heartbeat launcher gets.
- `GoalsService({ db, clock, scheduler, notifier?, tasks?, newId?, timezone?, onEvent?,
  maxOpenCandidates? })`:
  - `create(input)`: a stated goal, active at once, with milestones and a `cadence` (5-field cron
    or ISO-8601 duration) that becomes a system check-in automation on the scheduler.
  - `propose(candidate)`: an inferred goal as a `candidate` (`inferred: true`, evidence required in
    `plan.evidence`). Returns the open goal with the same title instead of a duplicate, and
    `undefined` when the same goal was rejected before or `maxOpenCandidates` are already open.
  - `decide(goalId, "confirm" | "reject" | "later")`: confirm activates (and only then may a
    cadence, milestones or links be added); reject archives and suppresses the proposal; later
    defers (`plan.deferredUntil`, `plan.deferrals`).
  - `get`, `list`, `progress`, `update` (title, category, status `active | paused | done`, plan,
    cadence), `archive`, `milestone` (add / edit / complete / remove), `link` (exactly one of
    task, automation, watch; `unlink`).
  - `checkinJob()`: the in-process job behind check-in automations. It raises at most one
    `reminder` (dedupe key `goal:<id>:checkin`, route `/goals/<id>`) with milestone and task
    progress and reports `no_reply` to the scheduler, so nothing else is delivered.
  - `start()`: after a restart, re-creates lost check-ins, refreshes `nextCheckinAt`, removes
    check-ins whose goal is gone.
- `createGoalHandlers(goals)`: `goals.list | get | decide | create | update | archive | milestone | link`.
- `withProactiveJobs(inner, { jobs, heartbeat?, onError? })`: wraps the scheduler's `RunLauncher`
  (S07's `withDreaming` pattern). Automations whose prompt is a job marker `[psyche:<job> <arg>]`
  run in-process without an agent turn; `heartbeat` automations go to the bounded launcher; every
  other run reaches `inner`. A job that throws fails its run with a generic summary (the detail
  goes to `onError`), and the scheduler raises its usual `task_failed`.
- `jobMarker`, `parseJobMarker`, `cadenceKind`, `GoalStore`, `normalizeTitle`.

### Feed (O5, O6)

```
interests.md ──▶ topics + embeddings ──┐
sources ──▶ candidate pool ──▶ dedupe by url ──▶ clusters (cos ≥ 0.82 or same title)
  (RSS/Atom, HN, arXiv,                 │
   saved items, accounts)               ▼
                      recall × recency − excluded topics − hidden hosts
                                        │   (paid search only for topics nothing covered)
                                        ▼
                      shortlist (3× bound) ──▶ seeded shuffle ──▶ utility-model rerank
                                        │
                                        ▼
                 top N−e posts + e exploration slots ──▶ posts written with citations [n]
                                        │   (no citation → templated post; never dropped silently)
                                        ▼
                 feed_posts rows {citations, reasons, exploration, briefingId} + feed.updated
```

- `FeedService({ db, clock, scheduler, memory, provider?, model?, embedder?, fetch?, search?,
  sources?, newId?, timezone?, onEvent?, maxPosts?, explorationSlots?, onUsage? })`:
  - `ensureDailyBrief({ schedule = "0 7 * * *", timezone })`: one system `briefing` automation
    (marker `[psyche:feed-brief daily]`).
  - `createBriefing({ title, schedule, instructions, timezone?, delivery? })`: a user briefing;
    the prompt is the marker plus the owner's instructions, which steer recall (an extra
    interest at 0.8), the rerank and the post writer. Delivery is the scheduler's (thread,
    channel), so a briefing reaches the owner the way O1 automations do.
  - `generate({ briefingId? })`: the pipeline above; returns posts, per-source reports (a failing
    source is a row, never fatal), whether the model was used, and token usage.
  - `list({ since?, briefingId?, cursor?, limit? })` with `nextBriefAt`.
  - `feedback({ postId, feedback | null, topic? })`: the ledger rules below, applied to the
    file at once (etag; an owner edit in between is re-read and kept), one audit line in today's
    daily note, `feed.post` event; `null` undoes the previous feedback.
  - `job()`: the in-process job for brief and briefing automations. Posts → `done` with a text
    deliverable (titles and first citations) that the scheduler delivers once (inbox `briefing`,
    thread or channel); no posts → `no_reply`.
  - `readLedger()`.
- Sources: `rssSource(url)`, `hackerNewsSource()`, `arxivSource()` (one query per top topic),
  `providedSource(id, kind, provider)` for saved items, connector summaries and a Bluesky
  Jetstream tap supplied by other packages, `searchGaps(search, topics)`. All reads go through the
  injected `FetchLike`; `publicFetch()` is the guard used until S09 exports its SSRF-policed fetch.
- Ranking helpers: `dedupe`, `cluster`, `scoreClusters`, `pickExploration`, `gapTopics`,
  `seededShuffle`, `seedFrom`; model helpers `rerank`, `writePost`, `checkCitations`,
  `templatePost`, `extractJson`.
- `createFeedHandlers(feed)`: `feed.list | feed.feedback | feed.generate`.

#### Interest ledger rules (`interests.md`)

Lines: `- <topic> (<weight>) — <why>`, `- !exclude: <topic> — <why>`, `- !hide-source: <host> — <why>`.
Everything else in the file is kept verbatim; the template's commented examples are not entries.

| Feedback | Effect on the post's matched topics | Undo (`null`) |
| --- | --- | --- |
| `like` | +0.10 each (cap 1.00) | −0.10 |
| `save` | +0.15 each (cap 1.00) | −0.15 |
| `not_interested` | −0.20 each (floor 0.05); the third time at the floor the topic becomes `!exclude:` | +0.20 |
| `hide_source` | adds `!hide-source: <host>` for every citation host | removes those lines |
| `follow_topic` | adds `<topic> (0.60)` (and drops a matching `!exclude:`); +0.20 if it exists | removes the line it created, else −0.20 |

A `like` / `save` on a post that matched no topic adds the title's key phrase (0.40 / 0.50). Every
change appends a note to the line's "why" (`like 2026-10-19 (post <id>)`) and one audit line to
today's daily note (`agent` provenance). Owner edits win: the file is re-read before each change.

#### Ranking rules

- Recall: for each topic, `similarity × weight`, where similarity is the embedding cosine, with a
  floor of 0.6 when every content word of the topic appears in the cluster's text (so a ledger
  works before any embedding model is configured). Briefing instructions act as a topic at 0.8.
- Excluded topics drop a cluster at similarity ≥ 0.6; hidden hosts drop their items.
- Recency: half-life 36 h (`2^(−age/36h)`); undated items count 0.5. Score =
  `recall × (0.5 + 0.5 × recency) + min(0.1, 0.05 × log2(sources))`.
- A url posted in the last 7 days is not posted again.
- The shortlist (3× the bound) is shuffled with a seed derived from the batch id before the
  rerank (position-bias mitigation); the rerank's answer must be a permutation of item numbers,
  anything else keeps the recall order and the posts say so (`recall order`).
- Exploration: the freshest clusters with recall < 0.3, labelled `exploration slot`.
- Every post's `reasons` lists the matched interest and its contribution, recency, cluster size,
  rerank position, exploration and who wrote it (`written by the model` / `templated (…)`).

## Gateway wiring

`composeProactive({ db, clock, scheduler, notifier, tasks, publish, timeZone, logger })` in
`apps/gateway/src/compose/proactive.ts`: mounts the handlers, forwards `goal.updated`, wraps the
scheduler's launcher (`proactive.launcher(createTaskLauncher(...), pool)`) and syncs check-ins on
`start()`.

## Invariants (tested in `test/`)

- **Bounded.** Candidates stop at `maxOpenCandidates`; a check-in raises one reminder however
  many ticks it coalesced; the heartbeat task carries `maxTokens: 5000` and an overspending run
  is stopped and reported once.
- **Attributable.** A candidate without evidence is rejected; every reminder carries the goal's
  route; `plan.evidence` and `plan.source` say why a candidate exists.
- **Dismissible.** `decide("reject")`, `archive`, `notifications.resolve`.
- **Confirm-first.** Before `confirm`, a candidate has no automation, task, notification, link
  or milestone, and the agent is never started for it.
- **No sends or writes.** This package calls no channel adapter, connector or model tool. Its
  only outward effects are rows in its own tables, system automations, `interests.md` (agent
  provenance) and the daily-note audit line; brief deliverables go through the scheduler's
  deliverer (inbox, thread, channel), which already asks the Permission Broker for webhooks.
- **Untrusted content stays data.** Source text is stripped of tags, capped, fenced as
  `<<<untrusted-data>>>` in prompts whose system message says never to follow instructions
  inside it, and the model's answers are parsed strictly (a permutation; a cited JSON post). Post
  bodies are built from web content: clients must treat them as untrusted when seeding a side
  chat ("Ask Wren").

## How this package maps to the docs

- Tables `feed_posts`, `ideas`, `goals`, `goal_milestones`, `goal_links` (data model §8) in
  `packages/db/migrations/202610201700_proactive_init.sql`, mirrored in `packages/db/src/schema-s15.ts`.
  Additions: `feed_posts.exploration`, `feed_posts.batch_id`, `ideas.pattern_key`,
  `ideas.dismiss_reason`, `goal_milestones.position`, `goal_links.created_at`.
- Check-ins arrive as `reminder` notifications (UI §3.11); the confirm card reads `plan.evidence`.

## What is stubbed

- Ideas (PR 3) and goal watches (PR 4).
- Bluesky Jetstream, saved Library items and connector summaries are `providedSource` hooks;
  nothing supplies them yet (S13 Library, S09 connectors). Paid search is wired as `search` but
  no provider is configured in the Gateway.
- Embeddings use the provider's `embed` when the router offers one; otherwise the hashed
  bag-of-words vector. `interests.md` embeddings are recomputed per batch (no cache table).
- Feed sources are read from the `feed.sources` setting; there is no `feed.sources.*` method yet
  (the owner edits the setting or `interests.md`).
- Goal plans as artifacts (the PDF plan in UI §3.11) and typed delete confirmation are UI (S12).
- `goal.*` agent tools (architecture §4.3 built-ins) wait for the Ideas PR.
