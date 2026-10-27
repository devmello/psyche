# @psyche/proactive

**Owner:** S15 (`docs/archive/prompts/s15-proactive-notifications.md`). Feature ids: O2 (heartbeat budget), O5–O9
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
| Ideas pipeline, acceptance model, delivery windows, `ideas.*` | O7, O8 | **done** (PR 3) |
| Goal watches, budget audit | O3 | **done** (PR 4) |

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
  - `addWatch(goalId, { url, check, selector?, text?, threshold?, every = "PT6H", title? })`: a
    scheduler `watch` automation linked as `goal_links.watch_id` (the automation's id). The
    scheduler fetches through its injected `watchFetch`, alerts once per transition (a price
    drop produces one `proactive` alert), backs off on failures (interval × 2^failures, ≤ 24 h)
    and never starts the agent. Linked watches run only while the goal is active (pause, done
    and archive disable them). `removeWatch(goalId, automationId)` unlinks and deletes;
    `progress()` lists each watch with its last status (`missing` when deleted elsewhere).
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
  - `readInstructions()`: the owner's free text in `feed/INSTRUCTIONS.md` ("What should I write
    about", #614; written by the Feed's instructions sheet through `memory.write`). HTML comments
    are dropped and the text is capped at 4,000 characters. Each batch places it in the rerank and
    post-writer prompts ahead of the `interests.md` lines, and posts ranked with it carry the
    reason `feed instructions`. It does not steer recall: an instruction to avoid a topic would
    otherwise pull that topic in. A missing or comment-only file means no instructions.
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

### Ideas (O7, O8)

```
nightly mine job (02:30) ─▶ miners
   (a) tool sequences in the owner's main / side threads (3+ runs, 2+ days) → SKILL.md drafts
   (b) daily notes ([owner] only): "I need to …" on 2+ days → task ideas;
       "I want to …" on 2+ days → GoalsService.propose (confirm-first goal candidates)
       active goals: no cadence → check-in idea; no task on the next milestone → plan idea
   (c) connector signals (S09): unanswered mail ≥ 3 days, subscriptions, upcoming trips
 ─▶ suppression ─▶ queued (delivered_at NULL)
delivery window (09:00) ─▶ refit the acceptance model ─▶ p ≥ 0.3, best first, ≤ 5
 ─▶ delivered (ideas.list) + one `proactive` notification (dedupe key ideas:window)
ideas.accept ─▶ Task in the main thread (createdFrom: idea) │ Automation │ goal cadence
ideas.dismiss ─▶ suppression + a training example
```

- `IdeasService({ db, clock, scheduler, tasks, mainThread, memory?, goals?, notifier?, signals?,
  newId?, timezone?, onEvent?, perWindow?, minAcceptanceProb?, sequences?, onError? })`:
  `mine()`, `deliver()`, `list({ status?, cursor?, limit? })` (delivered ideas only; default
  `proposed`), `accept({ ideaId, recurring?, brief?, schedule?, timezone?, threadId? })`,
  `dismiss(ideaId, reason)`, `model()`, `stats()` (the ADR-012 acceptance-rate metric),
  `ensureSchedules({ mine?, windows?, timezone? })`, `job()`.
- `createIdeaHandlers(ideas)`: `ideas.list | ideas.accept | ideas.dismiss`.
- Miners and helpers: `loadToolRuns`, `findSequences`, `sequenceCandidates`, `skillDraft`,
  `loadOwnerNotes`, `mineNotes`, `mineGoals`, `signalCandidates`, `fitAcceptanceModel`.

#### Suppression rules

| History of the same pattern (or source) | New candidate |
| --- | --- |
| open (queued or delivered) | not queued |
| accepted / edited | never again |
| dismissed `not_interested` | never again |
| dismissed `never_from_source` | nothing from that source again |
| dismissed `not_now`, or expired | not for 7 days, then allowed |

#### Acceptance model

Logistic regression over `bias`, `kind`, `source`, source family (`connector`), effort
(log-scaled minutes) and evidence count (log-scaled), fit by batch gradient descent (300
iterations, rate 0.5, L2 0.02) on delivered, decided ideas before every window. Labels: accepted /
edited 1 (weight 1); dismissed `not_interested` / `never_from_source` 0 (1); `not_now` 0 (0.3);
expired after delivery 0 (0.2). No history → 0.5. Below `minAcceptanceProb` (0.3) an idea is
held for a later window until it expires (14 days).

#### Accepting

- `task` action → `TaskEngine.create({ threadId: main, createdFrom: "idea" })`, so a task card
  appears in chat (O8). An idea whose evidence is untrusted (connector text) starts tainted
  (`taintSources: [{ sourceKind: "idea", origin }]`); its brief quotes the untrusted values and
  says they are data, and tells the task to draft, not send.
- `automation` action (subscription audit) → a scheduler automation whose prompt is template
  text only; `recurring: false` gives the one-off task instead.
- `recurring: true` on a task idea needs a `schedule`; an untrusted idea also needs the owner's
  own `brief` (`conflict` otherwise), so account text never becomes a standing instruction.
- `goal_cadence` → `goals.update({ cadence })`; plan ideas link their task to the goal.
- A `brief` marks the idea `edited`.

### Agent tools (`src/tools/index.ts`)

`proactiveTools({ goals?, ideas?, feed?, clock })` returns `defineTool` registrations for the
agent loop's registry (architecture §4.3 built-ins "`goal.*`, `idea.*`, `feed.*` (read-mostly)").

| Tool | Side effect | Broker (balanced) | Result provenance |
| --- | --- | --- | --- |
| `goals.list` | none | allows | trusted |
| `goals.propose` | write | asks; creates a candidate only (confirm-first) | trusted |
| `goals.update_progress` | write | asks | trusted |
| `goals.add_checkin` | write | asks | trusted |
| `ideas.list` | none | allows | `untrusted` when any listed idea has connector evidence |
| `ideas.accept` | write | asks; the task card lands in the current conversation | trusted |
| `ideas.dismiss` | write | asks | trusted |
| `ideas.snooze` | write | asks (`not_now`: may return after 7 days) | trusted |
| `feed.list` | none | allows | `untrusted` (web text) |
| `feed.mark_read` | none | allows (read state only) | trusted |
| `feed.explain` | none | allows | `untrusted` (web titles) |

- Each write's `describeCall` binds the approval to the exact arguments (`bindingFields`) and
  gives the card a one-line summary. The broker infers the kind (`connector_action`).
- Owner only: a turn requested by a designated or allowed person gets `forbidden`.
- Taint: a tainted turn's `goals.propose` stores `provenance: "untrusted"` and the turn's taint
  sources in the candidate's evidence; its `ideas.accept` starts the task tainted with those
  sources and refuses to turn the turn's `brief` into a recurring automation prompt.
- Names are plural (`goals.*`, `ideas.*`) because the broker floors every `goal.*` tool to
  `write`, which would make reads ask.

### Batch proposals (mail and meeting workflows §8.1, #670 W2)

`ProposalService({ db, clock, broker, tools, mainThread, surfaces?, newId?, onEvent?, inverses?, onError? })`:
- `create({ title, calls, createdBy, postId?, threadId?, taint?, taintSources?, ttlMs?, undoOf? })`: a pending proposal of 1–100 exact calls; a tool above `write` is refused at once.
- `approve(id)`: builds each call's intent exactly as the agent loop does (validate, `describeCall`, side-effect floor, `paramsHash`, the kind's binding, the namespaced grant key) and asks `broker.requestBatch`. The broker decides every call now and refuses the batch when any call is denied, above `write` after its floors, a send (`send_email`), or a device-only or authentication kind. The result is one `batch` card, `once` only, that lists every call.
- When the owner approves, the broker mints one approved, once-only child approval per call (id `<batch>.<index>`), bound to that call's own binding. The service runs the broker's stored calls in order: it checks that each call's params still hash to what was decided, calls `verifyBinding` (consumed once), then runs the tool with the child as its `authority`, and records a receipt when the tool gave none. Results are per call; the proposal ends `done`, `partial` or `failed`. Editing the row after approval changes nothing.
- `dismiss(id)`, `undo(id)`: undo offers the inverse calls in reverse order for 30 s, when every call that ran has an inverse (`DEFAULT_INVERSES`: `mail_set_flags`, `gmail_modify_labels`). The undo is a new proposal with its own approval.
- `createProposalHandlers(proposals)`: `proposals.list | get | approve | dismiss | undo`; `approve` returns the caller's own surface's answer token only.
- **Known gap:** the agent loop's `before_tool_call` hooks and plugins do not run for batch calls. The broker's decision at request time does. Tracked for S02 in the W2 PR.

### New-mail poller (§4.7, #670 W3)

`MailWatcher({ scheduler, clock, sources, activeHours?, timezone?, wanted?, onError? })`:
- **Cadence:** a system `interval` automation (`PT10M`, `[psyche:mail-watch poll]`) runs `poll()` in-process. Outside active hours (default 08–22) it polls at most hourly.
- **Reads:** nothing is read unless an enabled `mail.received` event automation exists (`wanted`). It makes no model call.
- **Sources:**
  - `appleMailSource(tools)`: `mail_search {unread: true, since}`
  - `gmailSource(tools)`: `gmail_search_threads {query: "is:unread after:<epoch>"}`; a thread's message count is part of the event id, so a new message in a known thread is a new event
- **Events:** each source's cursor is the start of its last poll, so mail that arrives mid-poll is seen again and deduplicated rather than missed. Events carry account, ids, sender and subject; sender and subject are untrusted and travel as data only.

### Inbox digest and follow-ups (§4.1, §4.2, #670 W4)

`DigestService({ db, clock, scheduler, tools, memory, proposals?, feed, notifier?, provider?, model?, modelIsRemote?, loops?, isKnownPerson?, personName?, knownDomains?, timezone? })`:
- **Collect:** unread mail since the last digest (a cursor per source): Apple Mail `mail_search` plus up to 60 `mail_read` previews, and Gmail `gmail_search_threads` snippets. At most 200 messages. Senders are recorded in `mail_senders`.
- **Pre-sort, without a model, in this order:**
  1. the owner's `mail/RULES.md` (allow / always archive / not now until / category)
  2. lookalike senders of known domains, which become `unverified` and are never needs-you
  3. automated senders and receipts, which become `notifications`
  4. bulk senders and unsubscribe text, which become `newsletters`
  5. first-time senders who are not known people, which become `screen`
- **Classify the rest** on the utility model, 20 per call, sanitized (hidden text stripped) and fenced. "Needs you" and "soon" must quote a phrase that is really in the mail; otherwise the item is FYI. Unparseable output is FYI.
- **Batch proposals:** one per bulk group, each needing one card:
  - newsletters: mark read (`mail_set_flags` or Gmail `remove UNREAD`)
  - notifications: archive (`mail_move` to archive or Gmail `remove INBOX`)
  - FYI: mark read

  Nothing is sent or deleted.
- **Follow-ups:** the graph's due `waiting_on` loops (`loops`), each shown in at most two digests (`digest_loops`).
- **Output:** one Feed post (`kind: "digest"`, `card: {type: "digest", digest}`) and one `briefing` notification per day (dedupe `mail:digest:<date>`). The notification is in-app only when nothing needs you.
- **`setSenderRule(from, decision)`:** the card's Allow / Not now / Always archive and category moves, written to `mail/RULES.md` (which the UI may also edit with `memory.write`).
- **Schedule:** a system cron automation (`30 7 * * 1-5`) runs in-process. In the Gateway it is off until `mail.digest.enabled` is true (§7.5: upgrades start off).

### Voice profile, drafts and scheduling (§4.3, §4.4, #670 W5)

- **`VoiceService`** reads up to 100 sent messages, keeps only the owner's own text (quotes and signatures go), and writes `mail/VOICE.md` (greetings and sign-offs per tier: colleague, known person, other) and up to 40 short samples in `mail/voice-samples.jsonl`. Both are owner files; `reset()` deletes them and drafts then say no style is saved. The nightly refresh (`15 3 * * *`) is off until `mail.voice.enabled` is true. Owner addresses come from `mail.ownerAddresses`.
- **`DraftService.draft({via, messageId, instruction?, tone?, replyAll?})`** writes a reply on the utility model with the thread fenced as untrusted and the voice for the recipient's tier. It returns the body, the sentences that commit the owner (`commitments`) and a one-call proposal (`mail_reply_draft` or `gmail_create_draft`); nothing is saved until it is approved. `shouldAutoDraft` limits unasked drafts to short questions from known senders without money, documents or attachments.
- **`SchedulingService.proposeTimes({via, messageId, durationMin?, recipientTimezone?, holds?, who?})`** reads `calendar_free_busy`, picks three weekday slots in working hours with a 15-minute buffer (one per day), drafts the reply with both time zones and, when asked, proposes three tentative holds as one batch. `mail.schedulingLink` is offered only when set. `confirm({reply, slots, ...})` turns a reply that picks a slot into one card for the event; an ambiguous reply returns a question. Releasing the other holds is a separate approval, because deletes are destructive and cannot be batched.
- **Agent tools:** `mail.draft_reply` and `mail.propose_times` (side effect `none`, untrusted results); they only propose.

### Meeting prep and post-meeting notes (§4.5, §4.6, #670 W6)

- **`MeetingPrepService`:** a planner (`*/30 7-21 * * *`) reads the next 26 hours of `calendar_list_events`. It prepares meetings with someone else on them that the owner did not decline and that are not all-day. By default the meeting must also have someone outside the owner's domains or related mail (`meetings.prep.scope: "all"` widens it).
  - Each meeting gets two one-shot `reminder` automations: the prep run at T − 2 h (morning meetings at 07:00) and the delivery at T − 60 min. They are recorded in `meeting_preps`. Moving the event moves both, cancelling it removes them, and past meetings drop theirs.
  - A recurring meeting with the same title and attendees and no new mail since the last occurrence is "nothing new": `digestLinesToday()` feeds `DigestService.meetingLines`.
  - The prep run is read-only: attendees (`person`, else `contacts_search`), the last 3 threads with each, their open loops (`loops`), matching notes, and the last meeting's decisions and action items (`previousNotes`). Every line cites its source. The utility model writes only "why" and, when the invitation has no agenda, up to 4 agenda bullets, with the invitation fenced as untrusted; the prep is always tainted.
  - The prep is one Feed post (`kind: "meeting_prep"`). Delivery is one `reminder` notification with Join, at most 4 a day. Thin preps (fewer than 2 sourced items) stay silent. `breakQuietHours` is set only when the meeting itself is inside quiet hours (`isQuiet`). In the Gateway it is off until `meetings.prep.enabled`.
- **`MeetingNotesService`:**
  - `fromRecording` refuses recordings over 4 h, transcribes through an injected `MeetingTranscriber` (`VoiceMemoService.ingestMeeting`), then calls `fromTranscript`.
  - `fromTranscript` matches the overlapping calendar event, then summarizes: one primary-model pass up to 60 minutes, or 30-minute chunks on the utility model above that. It produces a summary, decisions and action items with timestamps, where quotes must appear in the transcript, plus open questions.
  - The owner's items become one batch proposal of `reminders_create` (or `things_add`). Other people's items become "they owe you" loops (`addLoop`). Items with no clear owner are listed as unassigned.
  - The output is one Feed post (`kind: "meeting_notes"`, labelled AI-written) and one `task_done` notification. With only a cloud model and no permission it asks once (`input_needed`) and does nothing else.
  - `recapDraft(postId, {to?})` writes a recap from the notes alone, addressed to the accepted attendees (editable). It is saved only through a `mail_draft` proposal.
- **`MeetingRecorder`:** capture starts only after `consentConfirmed`. The source ends it (5 minutes of silence, the conference app quits) or `stop()` does.

## Gateway wiring

`composeProactive({ db, clock, scheduler, notifier, tasks, publish, timeZone, logger })` in
`apps/gateway/src/compose/proactive.ts`: mounts the handlers, forwards `goal.updated`, wraps the
scheduler's launcher (`proactive.launcher(createTaskLauncher(...), pool)`) and syncs check-ins on
`start()`.

## Invariants (tested in `test/`; `test/budget.test.ts` audits them together)

`budget.test.ts` runs one simulated day on one real scheduler (heartbeat every 30 min in active
hours, a goal with a daily check-in and a price watch, the 07:00 brief, nightly idea mining and
the 09:00 window) and checks every bound below at once: one heartbeat notification, one reminder,
one watch alert, one briefing, one ideas notification, at most five interruptions in all, every
notification routed and resolvable, no channel send, no task, no agent run except the
heartbeat's light runs.

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
  `packages/db/migrations/202610201700_proactive_init.sql`, mirrored in `packages/db/src/schema-s15.ts`;
  `202610210900_proactive_ideas-delivery.sql` adds `ideas.source`, `action`, `untrusted`,
  `delivered_at`; `202610211100_proactive_feed-read.sql` adds `feed_posts.read_at`.
  Additions: `feed_posts.exploration`, `feed_posts.batch_id`, `ideas.pattern_key`,
  `ideas.dismiss_reason`, `goal_milestones.position`, `goal_links.created_at`.
- Check-ins arrive as `reminder` notifications (UI §3.11); the confirm card reads `plan.evidence`.

## What is stubbed

- Ideas: connector signals need S09's provider (`signals`), nothing supplies it yet. Skill drafts
  are saved by the accepted task as `draft-unverified`; the replay verification and install go
  through S16's skill loader (`skill_install` approval) and are not automated here.
- Bluesky Jetstream, saved Library items and connector summaries are `providedSource` hooks;
  nothing supplies them yet (S13 Library, S09 connectors). Paid search is wired as `search` but
  no provider is configured in the Gateway.
- Embeddings use the provider's `embed` when the router offers one; otherwise the hashed
  bag-of-words vector. `interests.md` embeddings are recomputed per batch (no cache table).
- Feed sources are read from the `feed.sources` setting; there is no `feed.sources.*` method yet
  (the owner edits the setting or `interests.md`).
- Goal plans as artifacts (the PDF plan in UI §3.11) and typed delete confirmation are UI (S12).
- `goal.*` agent tools (architecture §4.3 built-ins) wait for the Ideas PR.
