# Psyche run trace 2026: specification and implementation plan

Status: proposal v1 (2026-10-25), for the owner's sign-off. It applies to psyche-desktop and psyche-web, and builds on [redesign-2026.md](redesign-2026.md) (the visual language, §3), [motion.md](motion.md) and the copy rules in [../copy/voice.md](../copy/voice.md).

Companion documents:
- [research/agent-traces.md](research/agent-traces.md): sourced notes on how 15 products present agent steps, branches, time, failures, replay and cross-run overviews.
- [../04-data-model.md](../04-data-model.md) §2, §11, §12, which §4 of this document extends.
- [../02-architecture.md](../02-architecture.md) §14 (observability), which this document makes concrete for runs.

**The owner's brief:** "Make following the agent's workflow as cool as possible and you can view the individual steps and everything."

**The short answer:**
- Today a run shows as a live step log in the chat (#630). It has tool steps with pending, ok and failed states, Thinking steps (#635) and a stalled hint. The log disappears when the run ends. Past runs can't be reopened, task and automation runs use a separate model, and nothing shows branches, time, cost or frames.
- This spec makes one **trace** of every run, in two levels of detail:
  1. **Steps**, in the chat. A calm, live list while Psyche works, which settles into one summary row when it's done.
  2. **Timeline**, in the agent sheet. A real debugging surface: a waterfall with branches, a step inspector with the redacted input and output, durations, tokens and cost, the frames Psyche saw, replay with a scrubber, and export.
- Across everything that's running, **Activity → Now** becomes mission control: live rows with the current step, elapsed time and a sparkline, then what's scheduled next.
- Underneath sits one additive protocol for every kind of run: `run.step` events and `runs.*` methods, with step ids shared with `chat.reasoning` and tool calls, and a run store with retention and redaction.

---

## 1. What the research says

The full notes, with sources and dates, are in [research/agent-traces.md](research/agent-traces.md). This section keeps what changes the design.

Numbers in brackets point to the numbered Sources in the research notes.

**What the best ones share:**
- **One step model, several views.** Braintrust, Langfuse and Temporal draw the same span tree as a list, a conversation, a timeline and raw JSON [37][38][48][50]. Psyche stores one tree and renders a *story* (the chat) and a *debugger* (the Timeline) from it (§2, principle 1).
- **A finished turn folds to one line.** Braintrust's "Worked" block and Claude Code's "Cooked for 1m 6s" show duration, calls and errors [5][48]. This is the default for a non-technical owner (§3.2).
- **A small, closed set of states, with "needs you" first.** Linear: pending, active, awaitingInput, error, complete, stale [59]. Claude Code's agent view: Working, Needs input (yellow), Idle (dimmed), with input-needed sorted first [4].
- **The live line replaces itself, and verbs flip tense.** Linear swaps ephemeral activities in place, and "Searching" becomes "Searched" when a step ends [59]. Claude Code rate-limits background summaries to about every 15 s [4].
- **Retries are first-class.** Inngest draws each attempt as its own bar with an "Attempt N" badge [53]; Temporal shows the attempt count and the next retry time [51][52]. A failed attempt is never silently overwritten.
- **Failures open themselves.** GitHub expands failed steps, Inngest selects the Error tab, and Braintrust shows the error beside its input [48][53][61].
- **Honest time.** Inngest splits a bar into queue and execution [53]. OpenAI's trace shows parallel agents overlapping, with zoom and fit [20]. Unknown tokens show as "—", never 0 [20].
- **Roll-ups.** Tokens and cost on every step, summed into parents (Braintrust, LangSmith) [44][48].
- **Step-indexed time travel beats video.** A reviewer found ChatGPT agent's replay video "pretty boring" [23]. Devin jumps the session to a clicked command and greys what came after [12]; Instruments filters by a dragged time range [55].
- **Rerun from a step.** Inngest reruns from a step with its earlier results reused [54]; Replit's checkpoints roll back and branch [32].
- **Redact by default.** Claude Code's and OpenAI's telemetry exclude content unless opted in [6][19]. Langfuse and LangSmith mask before export [42][46]. Operator never records takeover typing [21].

**What makes traces noisy** (the anti-patterns this spec designs out):
- Every tool call at equal weight. Claude Code folds repeats ("Called slack 3 times") [1], and Linear groups similar events [58].
- Raw chain-of-thought inline by default [5][31].
- Video as the only replay [23].
- Zero shown for unknown, or totals that silently skip sub-agents [20][45].
- Ever-growing status text [4][59].
- Search that misses folded content [38][61].
- Silent hangs. Linear marks an agent unresponsive after 10 s with no first activity, and stale after 30 min [60]. Nielsen's 10 s limit [66].
- Motion that conveys no state [5].

**Data:**
- The OpenTelemetry GenAI conventions (`invoke_agent`, `execute_tool`, `gen_ai.usage.*`) are still in development, with content opt-in [see Data model notes].
- The common shape is an append-only event log folded into a span tree, exportable as OTLP JSON.
- Retention varies: Langfuse keeps indefinitely, LangSmith 14 or 400 days, Claude Code cleans up after 30 days.

**Gaps in the research:** OpenAI's own Operator pages were unreachable, so that section uses its system card and dated reviews. Manus and Perplexity Computer don't document their step lists. No documented Devin scrubber was found.

## 2. Principles

1. **Two levels, one model.** The chat shows *what Psyche is doing* in plain words. The Timeline shows *exactly what happened*. Both read the same steps, so a step never says one thing in the chat and another in the Timeline.
2. **Alive, not busy.** One thing moves at a time: the step that's running. New steps enter, settle and stop moving. Elapsed time ticks only on the active step. Nothing loops after the run ends (motion.md §1, SC 2.2.2).
3. **Progressive disclosure.** In the chat a step is one line. It opens to a short preview, and the raw input and output live only in the inspector. The disclosure levels match docs/06 §3.2 (0 status, 1 actions, 2 raw, ⌃O).
4. **Time is the spine.** Every step has a start and an end. Durations are always visible in the Timeline and on hover or focus in the chat. Parallel work lays out side by side, never as a confusing interleave.
5. **Failures are the headline.** A failed run opens on the step that failed, with what happened, what Psyche did and what you can do (voice.md rule 4). Retries stack on their step instead of adding noise.
6. **Private by default.** Secrets are redacted at write time, before anything is stored, streamed or exported. Reasoning and frames have a retention the owner sets.
7. **Honest numbers.** Durations, tokens and cost come from the Gateway. Psyche never invents an ETA. "Usually takes about 2 min" appears only for an automation with at least 3 past runs.

## 3. Design

### 3.1 Words (amends the copy glossary)

The glossary says "task, not run". The trace keeps that rule in user-facing text and adds three nouns:

| Use | Not | Meaning |
| --- | --- | --- |
| step | span, event, action (in the chat) | One thing Psyche did: thought, used a tool, asked, waited, handed work to a helper |
| Timeline | trace, run view, log | The full view of one task's steps over time, in the agent sheet |
| helper | subagent, child agent | Work Psyche handed to a parallel copy of itself (`subagent.spawn`) |

- "Run", "span" and "trace" stay internal (protocol, code, export format names).
- A chat turn that does work is still called a task in the UI: "Wren worked for 1 min 12 s".
- Status lines follow voice.md: a present participle plus an object, under 48 characters ("Reading your calendar", "Comparing 3 flights").

### 3.2 Steps in the chat (the inline log's final form)

This extends #630's `RunStepLog`. The log no longer disappears at the end of a run: it settles into a summary row.

**While working** (in place of the "Wren is working…" line):

```
(avatar) Wren · Working · 0:42                                   [Stop]
  ✓ Thought about the trip dates                              3 s
  ✓ Searched flights  ·  kayak.com                            8 s
  ┌ 3 at once                                                      
  │ ✓ Read SFO → LIS                                          2 s
  │ ● Reading SFO → OPO  ▸ frame                          0:05 ⟳
  │ ○ Read SFO → MAD                                               
  └                                                                
  ● Comparing 3 flights                                     0:04
     [Show all 9]                                     [Open Timeline]
```

- **Rows:** a status glyph, then the label (voice.md status line), then a target in the secondary label colour after a `·`, then the duration right-aligned in tabular numbers. The label flips tense when the step ends: "Searching flights" becomes "Searched flights" (`label` and `doneLabel`, §4.2). The active row shows elapsed time as `m:ss`, ticking once a second. Finished rows show a rounded duration ("3 s", "1 min 4 s").
- **Glyphs** come from `components/status.tsx` (`StatusKind`), plus a thinking glyph:
  - `○` pending
  - `●` running, with the shared opacity pulse
  - `✓` ok
  - `✕` failed, in the danger colour
  - `⏸` waiting on you
  - `↻` retried, with a count
- **Thinking steps** (#635) keep their collapsed first line ("Thinking: the 7th is a Sunday…"). They expand to the full text, which is streamed and redacted. The full text exists only while it's retained (§4.3); after that, the row shows the one-line summary.
- **Parallel work:** consecutive steps that ran at the same time group under a bracket labelled "{n} at once". Up to 3 rows show, and the rest fold into "+{n} more".
- **Helpers:** a helper's work nests one level under its step, behind a vertical rail in `--separator`. It shows the helper's own active row live and folds to "Helper · 6 steps · 41 s" when done. Nesting stops at one level, because helpers can't spawn helpers.
- **Approvals and questions** show as rows that point at their card ("Waiting for your approval ↓"). They turn into a step with the outcome ("Allowed once") when answered (#619's single-row behaviour).
- **Frames:** a browser or computer-use step shows a 32 × 20 thumbnail of the latest frame after its label. Clicking it opens the Timeline's frame viewer on that frame.
- **Repeats fold:** consecutive steps with the same tool and outcome fold into one row ("Read 4 pages · kayak.com", ×4), which expands in place.
- **Folding:** the last 5 steps show while working (`VISIBLE_STEPS`). Earlier ones fold into "Show all ({n})". Failed steps never fold away.
- **Stalled:** after 30 s with no event, the active row adds "No response for {duration}" (`STALL_MS`, as today).

**When the run ends**, the log condenses into one summary row in place, the anchor between the user's message and the reply:

```
▸ Worked for 1 min 12 s · sent 1 email · added 1 event · 9 steps        (Timeline ›)
```

- Side effects come first (what was sent, created, changed or paid, from receipts). Read-only work is only counted. With no side effects: "Worked for 41 s · read 6 pages · 9 steps".

- Failed: `✕ Stopped at step 7 · calendar.create failed · 1 min 4 s` (danger colour, never folded).
- Cancelled: `Stopped by you after 0:38 · 5 steps`.
- The summary replaces #630's folded `ToolRun` row ("3 actions · browser, calendar"). Expanding it shows the same rows as above, with final durations. Disclosure level 2 (⌃O) shows each tool step's redacted parameters inline, as `ToolCallRow` does today.
- A receipt line stays where it is (redesign §5.3). The summary row links to it but never repeats it.

**Motion** (the motion.md §4.9 addition, §3.7 here):
- A new row enters with `fadeRise` on `spring.snappy`. It's the list enter (§4.1), with no stagger, because steps arrive one by one.
- Glyph changes crossfade over `duration.short`, and the ✓ scales 0.8 → 1 on `spring.micro`.
- The active label carries the `psy-shimmer` mask (motion.md §4.7). It stops when the step ends.
- On completion, the list collapses into the summary row as a height and opacity transition on `spring.smooth`. The summary row's glyph is a shared `layoutId` with the run header's glyph in the Timeline.
- **Reduced motion:** rows appear without movement, there's no shimmer and no pulse, the elapsed time still updates, and the collapse is a crossfade.

**Accessibility:**
- The log is a `list` inside the transcript `log`, and each row is a `listitem`.
- The live region is polite and announces only the start of a step and its outcome. Durations and elapsed ticks aren't announced.
- "Stop" stays reachable with Esc (docs/06 §4.11).

### 3.3 Timeline (the agent sheet)

A new **Timeline** opens from three places: the summary row ("Timeline ›"), a task in Activity, and ⌘⇧T on the current thread (free in docs/06 §4.11, next to ⌘⇧A for Activity). It replaces the task detail's action log in `ActivityPanel` (`TaskDetail` + `ActionLog`), and it also covers chat runs, automations and helpers.

**Layout at 1440 × 900** (the sheet at its regular width, redesign §5.7):

```
┌ Run header ────────────────────────────────────────────────────────────────┐
│ ✓ Book flights to Lisbon        Done · 1 min 12 s · 9 steps · 41k tokens · $0.18 │
│ Started 10:42 by you in Main chat · claude-…              [Export] [⋯]     │
├ Waterfall ───────────────────────────────────────────┬ Inspector ──────────┤
│ 0s        15s        30s        45s        60s       │ Searched flights     │
│ Thinking ▇▇                                          │ ✓ ok · 8.1 s         │
│ web.search    ▇▇▇▇▇                                  │ Overview Input Output│
│ ┌ 3 at once                                          │  Timing Cost Frames  │
│ │ browser.open      ▇▇▇                              │ ──────────────────── │
│ │ browser.open      ▇▇▇▇▇▇▇▇                         │ { "query": "SFO→LIS",│
│ │ browser.open      ▇▇▇▇                             │   "dates": "…" }     │
│ └                                                    │                      │
│ Comparing             ▇▇▇▇▇▇▇▇▇▇▇                    │ Copy · Open receipt  │
├ Scrubber ───────────────────────────────────────────────────────────────────┤
│ ◀ ▶  1× ▾   |────────●──────────────────────| 0:31 / 1:12   ▣ frames strip │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Run header:**
- The state glyph, then the task title (the automation's or task's title, or the first line of the user's message for a chat task).
- One fact line: state, duration (live elapsed while running), steps, tokens and cost (the `Run.usage` totals), separated by `·`.
- A second line for provenance: when it started, who started it (you, an automation, a channel), where (the thread), and the model, plus the fallback model if the router switched.
- Running: an ETA when one is honest (principle 7), [Stop] and [Pause] (tasks).
- Done: [Retry] (and "Retry from here" on a step with a replay-safe checkpoint, `tasks.retry {fromStepId}`), [Export], and ⋯ (Copy link to step, Delete trace).
- Failed: a diagnosis banner under the header, using the danger surface:
  - **What happened:** "calendar.create failed · 403 from Google Calendar."
  - **What Psyche did:** "Tried twice, then stopped."
  - **What you can do:** "Reconnect Google Calendar" (a button that opens the connector), plus [Retry].
  - It is built from the failed step's error and the connector state (voice.md rule 4).

**Waterfall:**
- One row per step: the label at a fixed 200 px, then a bar on a shared time axis.
- Bars are 6 px tall, rounded 3 px, coloured by kind:
  - thinking: `--fill-secondary`
  - tool: `--accent-9`
  - waiting on you: `--approval`
  - failed: `--danger`
  - helper: the accent at 60%
- Parallel steps and helpers sit under a bracket, so the overlap is visible. Helper rows indent and fold the same way as in the chat.
- Idle gaps over 10 s (waiting on you, rate limits) collapse into a ⌇ break with the gap's length, so a 2-hour wait doesn't flatten everything else. Hovering a break shows the real time.
- Hover or focus shows a tooltip with the start time, duration, and tokens and cost for model steps.
- Retries are attempts on one row: each attempt is its own segment with a gap between, failed ones faint with a ✕, and an "Attempt 3" badge on the last. The inspector lists every attempt with its error and next-retry time.
- A bar is split honestly: time waiting on you (approval, question) and time queued (rate limit, a concurrency slot) are hatched segments in `--fill-tertiary`, then execution is solid.
- Tokens and cost roll up: a group or helper row shows its children's sum. Unknown values show "—", never 0.
- Model calls are rows too ("Thinking" or "Writing", with the model name in the inspector). That's where per-step tokens and cost come from (§4.2).
- Zoom: ⌘+ and ⌘−, ⌘0 to fit, and pinch on the trackpad. The axis relabels (s → min) with tabular numbers.

**List view:** a segmented control in the header switches Waterfall and List. List is one scrolling log of every step with its preview, including folded ones, so ⌘F finds text anywhere in the task.

**Step inspector** (a right pane at 360 px, or a bottom pane under 1100 px). A failed task opens with its failed step selected and the Output tab showing the error:
- **Overview:** the label, status, kind and tool, the target, and why. "Why" is the Thinking step just before this one, shown as a quote when it's retained. Links go to the receipt, approval, artifact, memory file (a diff of what changed) and the helper's own Timeline.
- **Input:** the redacted parameters as a collapsible JSON view. Vault values show as `‹vault: name›` and secret strings as `‹redacted›`. Actions: [Copy] (the redacted text) and a "Raw" toggle for pretty or exact JSON.
- **Output:** a preview of the result (text, a table for structured results, an image for a screenshot). Then the raw result, truncated at 64 KB with "Showing 64 KB of 1.2 MB" and [Save full output] when the payload is retained. Errors show the message and code first.
- **Timing:** queued, started and ended (absolute times, voice.md), the duration, and time waiting on approval when there was a wait.
- **Cost:** model steps show input, output, cache-read, cache-write and reasoning tokens, plus cost. Tool steps show "No model cost".
- **Frames:** the filmstrip for this step (§3.4).
- The inspector follows the scrubber: when replaying, it shows the step under the playhead.

**Keyboard:**

| Key | Action |
| --- | --- |
| ↑ / ↓ | Previous or next step (the inspector follows) |
| ← / → | Fold or unfold a group or helper |
| Return | Focus the inspector; Esc returns to the step |
| Space | Play or pause the replay |
| , / . | Step back or forward one event while paused |
| [ / ] | Previous or next failed or retried step |
| ⌘C | Copy the step's redacted JSON |
| ⌘+ / ⌘− / ⌘0 | Zoom the waterfall |

- The waterfall is a `treegrid`. Each row has a label, status, duration and level, and bars are decorative.
- Arrow keys move a roving focus; the selection fill plus an inset ring marks the focused row (redesign §8).

### 3.4 Frames: what Psyche saw

- Browser and computer-use steps keep the frames Psyche looked at, with the retention in §4.3. Browser recordings and computer-use screenshots meet in one frame model (§4.2).
- **Frame strip:** the scrubber carries a strip of 48 × 30 thumbnails, one per frame, placed at its time. The current frame is outlined in the accent.
- **Frame viewer:** the inspector's Frames tab, or a larger view. It shows the frame at full size with the action overlaid: the click point as a 12 px ring, typed text as a caption ("Typed ‹redacted› into Password"), the URL, and the frame's time.
- Secure fields are already masked at write time (`maskPng`), and frames aren't captured while a secure field is active (`recorder.ts`).
- Frames are lazy: thumbnails come from `runs.frame` at 96 px, and the full frame loads only when opened.

### 3.5 Replay and scrubbing (past runs)

- Every finished run can be replayed from its steps. Replay doesn't re-execute anything; it re-renders the trace's state at a point in time.
- **Scrubber:** a time axis with a playhead, with failed and approval markers on the track.
  - Dragging the playhead re-renders the waterfall up to that time: steps not yet started are hidden, and running ones show their bar growing.
  - The step list in the inspector updates, and the frame viewer shows the newest frame at or before that time.
- **Play:** 1×, 4× or 16×. Idle gaps over 10 s are skipped by default ("Skip waits", on). Playback stops at the end, or at a failure when "Stop at failures" is on.
- **Reduced motion:** there's no autoplay animation of bars. Play advances step by step every 600 ms, and scrubbing works normally.
- Clicking a step while replaying moves the playhead to its start; everything after it dims (Devin's jump-to-command).
- Dragging across the waterfall's axis selects a time range; the List view and totals filter to it (Instruments' inspection range).
- A running run has a "Live" pill on the scrubber. Dragging back pauses following and shows "Back to live", which jumps to now.

### 3.6 Activity → Now (mission control)

The agent sheet's Activity tab becomes four sections. It still lists tasks (voice.md), but every kind of run appears in it.

```
Needs you (1)
  ⏸ Pay the dentist invoice         Waiting for your approval   3 min
Now (2)
  ● Book flights to Lisbon          Comparing 3 flights        0:42  ▁▃▅▂▇
  ● Morning briefing · automation   Reading your inbox         0:08  ▂▂▅
Next up
  ○ Inbox triage · automation       in 14 min   · usually 1 min · ▁▁▂▁▃ (last 5)
  ○ Weekly review · automation      Fri 9:00
Recent
  ✓ Summarise the board deck        2 min 10 s · 14 steps        11:02
  ✕ Sync Notion tasks               Stopped at step 3            10:15
```

- Sort: Needs you first, then Now, everywhere a list of runs appears (the avatar menu, the sidebar badge, Activity).
- **Now:** every running run (chat tasks, tasks, automations, helpers fold under their parent). Each row has the current step's status line, live elapsed time, and a 60 s activity sparkline: steps per 5 s bucket, drawn with `Sparkline`, which is extended for live data (§7, T4). Clicking a row opens its Timeline. Rows enter and leave with the list motion.
- **Needs you:** approvals and questions blocking a run, linked to the card.
- **Next up:** enabled automations by `nextRunAt`, with a countdown, the honest usual duration, and a sparkline of the last 10 durations (failures as danger-coloured ticks).
- **Recent:** finished runs from the last 7 days, newest first, filterable by All, Failed, Automations or Chat, with search by title.
- The avatar's state ("Wren, working", redesign §8) and the sidebar badge count Now and Needs you.

### 3.7 Motion summary (adds motion.md §4.9 "Steps and the Timeline")

| Element | Full motion | Reduced motion |
| --- | --- | --- |
| New step row | `fadeRise`, `spring.snappy` | Appears in place |
| Status change | Glyph crossfade `duration.short`; ✓ scale 0.8→1 `spring.micro` | Crossfade only |
| Active label | `psy-shimmer`, stops at step end | Static; "· running" text |
| Elapsed time | Ticks 1 Hz, tabular numbers, no animation | Same |
| Log → summary row | Height + opacity on `spring.smooth` | Crossfade 120 ms |
| Summary glyph → Timeline header | Shared `layoutId` | Crossfade |
| Waterfall bar (live) | Width grows each animation frame while running (transform: scaleX) | Width updates 1 Hz |
| Playhead drag | Follows the pointer 1:1, no spring | Same |
| Replay play | Bars grow at playback speed | Step-by-step, 600 ms |
| Now rows | List enter and exit (§4.1) | Fade |
| Sparkline (live) | New bucket slides in over `duration.medium` | Redraws in place |

- Everything animates transform and opacity only, except the SVG sparkline path, which redraws at most at 1 Hz. The budget is motion.md §5's 120 Hz target.
- Live updates batch to one render per animation frame. Progress events are throttled to 4 per second per step (§4.4).

### 3.8 States

- **Empty:** for Activity, "Nothing running. Wren's next automation is Inbox triage, in 14 min." With no automations: "Nothing running."
- **Loading:** the Timeline shows a skeleton waterfall (5 rows with the shimmer) until `runs.get` returns, for at least 300 ms (motion.md §4.7).
- **Expired detail:**
  - When reasoning or frames are past retention, the step keeps its label and timing, and the tab says "Kept for 7 days. This step is older."
  - When outputs are past `cleanupPeriodDays`, it says "Output no longer kept."
- **Incognito:** no Timeline, because steps aren't persisted. The chat summary row says "Not kept · incognito".
- **Web compact (< 720 px):** the Timeline is a full-screen sheet. The waterfall becomes a vertical list with duration bars under each label, and the inspector opens as a pushed screen.

## 4. Data

### 4.1 What exists and what's missing

Grounded in the code at `41009f99`:
- **Persisted:**
  - `runs` (status, usage totals)
  - `tool_calls` (redacted params; `resultRef` always null)
  - `usage` rows per model call, linked only by `runId`
  - `task_actions` and `task_checkpoints` for task runs
  - `automation_runs` (no agent `runId`)
  - browser recordings (opt-in, keyed by task or thread)
- **Not persisted:**
  - `chat.reasoning` (by design in #633)
  - `ToolUpdate` progress (dropped at `session/controller.ts:743`)
  - helper runs (`onSubagentEvent` is unwired)
  - tool results (`tool_payloads` is written only in tests)
  - computer-use screenshots (inline base64 in the masked transcript only)
  - which run or step wrote a memory file
- **Missing reads:** there's no `runs.get`, `runs.list` or tool-call read. Runs reach the UI only by live events (`RunStepLog.tsx:77`).
- **Two models:** chat runs write `runs` and `tool_calls`, while task runs write only `task_actions`.

### 4.2 The step model (additive)

One append-only table, `run_steps`, written by the Gateway for **every** run: chat, task, automation and helper.

```ts
// packages/protocol/src/schemas/runs.ts (new)
RunStep = {
  id: Id,                    // the step id; see "Ids" below
  runId: Id,
  seq: number,               // per run, monotonic from 1; the replay order
  parentStepId?: Id,         // helper steps point at their spawn step; parallel groups share a groupId
  groupId?: Id,              // steps dispatched together (#runTools Promise.all)
  kind: "thinking" | "model" | "tool" | "approval" | "question" | "subagent" | "text" | "memory" | "artifact" | "note",
  status: "pending" | "running" | "ok" | "failed" | "waiting" | "cancelled" | "skipped",
  label: string,             // ≤ 160 chars, redacted, voice.md status line ("Searching flights")
  doneLabel?: string,        // the past-tense form once ended ("Searched flights"); from the tool's level1 templates
  target?: string,           // ≤ 120 chars, redacted (domain, file, recipient)
  startedAt: Timestamp, endedAt?: Timestamp,
  attempt: number,           // 1-based; retries add attempts to the same step id
  attempts?: { startedAt, endedAt, status, error? }[],   // earlier attempts, ≤ 5 kept
  toolCallId?: Id, approvalId?: Id, inputRequestId?: Id, receiptId?: Id,
  artifactId?: Id, memoryPath?: string, childRunId?: Id, taskId?: Id,   // subagent steps: the child run and its task
  modelRef?: string, usage?: Usage,                       // model steps only
  progress?: { message?: string, fraction?: number },     // last ToolUpdate, throttled
  preview?: { input?: string, output?: string },          // ≤ 2 KB each, redacted
  payloadRef?: { input?: Id, output?: Id },               // tool_payloads rows, ≤ 1 MB each
  frames?: { first: number, last: number },               // frame seq range in the run's recording
  text?: { summary: string, full?: string, expiresAt?: Timestamp }, // thinking: summary kept, full per §4.3
  error?: { code: string, message: string, retryable: boolean },
}
```

`Run` gains these optional fields (additive): `kind: "chat" | "task" | "automation" | "subagent"`, `title`, `parentRunId`, `rootRunId`, `taskId`, `automationRunId`, `stepCount`, `currentStepId`, `lastStepAt`, `origin: "owner" | "automation" | "channel" | "subagent"`, `budget?: {limit: {steps?, tokens?, wallMs?}, used: {steps, tokens, wallMs}}`, `deadline?: Timestamp`.

- Steps are addressed by `(runId, stepId)`. Branches are keyed by `childRunId` on the parent's `subagent` step; the child run has `parentRunId` and `rootRunId`.
- S02's background specialists (docs/agent/specialists-2026.md) use the same shape: a specialist is a child run backed by a Task (`createdFrom: "subagent"`, a specialist role id), and its spawn is a `subagent` step on the parent. In the UI a spawned copy is a "helper"; a specialist shows under its role's name.

**Ids:**
- The Gateway assigns step ids as ULIDs, prefixed by kind (`stp_`).
- A Thinking step's id **is** the `chat.reasoning` `stepId`. The loop's `rsn_` id becomes the step id, so the live stream and the stored step are the same object.
- A tool step's id is a fresh `stp_` id. `ToolCall` gains `stepId`, and `tool_call.updated` carries it, so the chat, the Timeline and receipts resolve to one step.
  - Provider-assigned tool-call ids aren't reused as step ids, because they aren't guaranteed unique across runs.
- Helper run ids move from `${parent}:sub:${id}` (which can exceed `Id`'s 64-character limit) to fresh ULIDs, with `parentRunId` set.

**Where each step comes from** (all in the Gateway; the loop gains no storage):

| Step | Source | Notes |
| --- | --- | --- |
| thinking | `reasoning` AgentEvent | Same id as `chat.reasoning.stepId` |
| model | `usage` AgentEvent | The model step covers the call; `usage` rows gain `stepId` |
| tool | `tool_call` AgentEvent | `update` (ToolUpdate) becomes `progress`, throttled 4/s |
| approval / question | `approval_requested`, `question` | `waiting` until answered; the outcome is the label |
| subagent | `subagent.spawn` (and S02 specialists) + `onSubagentEvent` | The child gets its own `runs` row (`parentRunId`, `rootRunId`); the step carries `childRunId` and `taskId` |
| memory | `memory.file.changed` with `source: tool` | The event gains `runId` and `stepId` |
| artifact | `block` (artifact) | Links `artifactId` |
| text | `chat.delta` boundaries | One step per written reply, for timing only (no text copy) |

**Task and automation runs:** the task worker (`packages/tasks/src/worker.ts`) writes `runs`, `tool_calls` and `run_steps` through the same Gateway sink as chat runs, and publishes `run.updated` and `run.step`. `task_actions` stays as the task's action log until its UI moves to the Timeline. `AutomationRun` gains `runId` and `usage`.

**Frames:**
- One frame model per run, stored under `$PSYCHE_HOME/library/recordings/<runId>/`: the existing recorder layout with `index.json` and JPEG frames.
- Browser recordings keep their recorder, and their events gain `runId` and `stepId`.
- Computer-use screenshots are written as frames: downscaled to a long edge of 1280 px, JPEG at quality 70, masked as today. The tool output keeps a frame reference instead of inline base64.

### 4.3 Retention and the reasoning decision

#633 kept reasoning transient. This spec makes it **kept for 7 days by default, behind a setting**, because the Timeline's "why" and failure diagnosis depend on it and the owner asked to "view the individual steps and everything".

| Data | Default | Setting (Settings → Data controls → Memory) | Notes |
| --- | --- | --- | --- |
| Steps (label, timing, status, links, previews) | Kept with the thread | — | Deleted with the thread; incognito: never written |
| Thinking, full text | 7 days | New `data.reasoningRetentionDays`: Off · 1 · 7 · 30 days | Off = today's behaviour (summary line only). Never written when `agent.showReasoning` is off |
| Thinking, summary line | Kept with the thread | — | ≤ 120 chars, redacted |
| Tool inputs and outputs (`tool_payloads`) | 30 days | Existing `cleanupPeriodDays` | Previews (2 KB) stay with the step |
| Frames (browser and computer use) | 7 days | Existing "Keep task replays for" (`data.replayRetentionDays`), gaining Off and 1 day | Today the UI shows 7 · 30 · 90 days (default 30) but the Gateway never reads it: the recorder prunes at 7 days (`compose/browser.ts:164`). T1 wires it, and the default becomes 7 days, matching what is actually kept. The browser-recording opt-in stays for full screencasts (every frame, not only the ones Psyche looked at) |
| Usage per step | Kept with the thread | — | Feeds Usage |

- Retention runs in the existing hourly `retention.ts` job. Expiry blanks `text.full` and frame files. The step keeps `expiresAt` so the UI can say why the detail is gone.
- "Delete trace" (⋯) removes a run's steps, payloads and frames but keeps receipts. Receipts and audit are never deleted (04-data-model §12).

### 4.4 Protocol (additive; version bump minor)

**Methods** (`methods/runs.ts`, new; scope `operator.read`):

| Method | Params | Result |
| --- | --- | --- |
| `runs.get` | `{runId}` | `{run, steps: RunStep[] (first 500), children: Run[]}` |
| `runs.steps` | `{runId, afterSeq?, limit? ≤ 500}` | `{steps, nextSeq?}` |
| `runs.list` | `{status?: RunStatus[], kind?, threadId?, taskId?, automationId?, parentRunId?, rootRunId?, since?, cursor?, limit? ≤ 100}` | `{runs: RunSummary[], cursor?}` |
| `runs.children` | `{runId}` | `{runs: RunSummary[]}`: child runs with status, `budget` and `deadline` (S02 mission control; the same as `runs.list {parentRunId}`) |
| `runs.step` | `{runId, stepId}` | `{step, input?: unknown, output?: unknown, truncated: boolean}` (payload bodies, redacted) |
| `runs.frames` | `{runId, stepId?, afterSeq?, limit?}` | `{frames: {seq, at, stepId, url?, width, height}[]}` |
| `runs.frame` | `{runId, seq, size: "thumb" \| "full"}` | `{mime, dataBase64}` |
| `runs.export` | `{runId, format: "psyche-trace+json" \| "markdown", includeFrames?: boolean}` | `{fileName, mime, dataBase64}` or a Library file ref over 8 MB |
| `runs.delete` | `{runId}` | `{ok}` (scope `operator.write`) |

`RunSummary` = `Run` fields plus `currentStep?: {label, status, startedAt}`, `activity?: number[]` (12 × 5 s buckets, for the sparkline), and `durationsMs?: number[]` (automations: the last 10).

**Events:**
- `run.step` `{runId, step: RunStep}`: an upsert per change, carrying the whole step except `text.full` and payloads. It's coalesced to one per step per animation frame on the Gateway (≤ 4/s for `progress`).
- `run.updated` (existing) gains the new `Run` fields.
- `chat.reasoning` (existing) is unchanged: the deltas stream there, and the stored text is read with `runs.step`.
- `events.subscribe` already takes prefixes; `run.*` covers both.
- `memory.file.changed` gains `runId?` and `stepId?`. `browser.recording.updated` events gain `runId?`.

**Reconnects:** a client that sees a `stateVersion` gap calls `runs.get` for each run it shows (the events aren't replayed, `event-bus.ts:60`). `runs.steps {afterSeq}` makes that cheap.

### 4.5 Limits

- Steps: 2,000 per run. Past that, consecutive same-tool steps fold into one "×n" step, and the run gets `note: "Some steps were folded"`.
- Labels: 160 characters. Targets: 120. Previews: 2 KB. Payloads: 1 MB each; past that, store the head and tail with a `truncated` marker.
- Thinking: 64 KB per step stored. Frames: 600 per run (past that, keep 1 per 2 s, plus every frame a step referenced).
- Events: `run.step` at most 4 per second per step for progress, and 50 per second per run overall. The rest coalesce, so the last state always arrives.

### 4.6 Redaction

- **At write, in the Gateway:**
  - Every label, target, preview, payload and Thinking text passes through the one `SecretRedactor` (`compose/index.ts:312`).
  - URLs pass through `redactUrlsIn`.
  - Parameters keep today's `paramsRedacted`.
  - Vault references are stored as `‹vault: name›`.
  - Frames keep `maskPng` and the secure-field pause.
- **Before display or export:**
  - Exports re-run the redactor (defence in depth) and drop payload bodies over the export limit.
  - Frames are included only when asked, and never for incognito.
- **Display:**
  - The inspector shows redactions as tokens, never as `***`, so the owner can tell a redaction from an empty value.
  - Copy copies the redacted text. There's no "reveal" for secrets: the values never left the vault.

### 4.7 Export format

`psyche-trace+json` v1 is one JSON document:

```json
{
  "format": "psyche-trace", "version": 1, "exportedAt": "…", "redacted": true,
  "run": { "id": "…", "kind": "task", "title": "…", "status": "done", "startedAt": "…", "endedAt": "…", "usage": { … }, "model": "…" },
  "steps": [ { "id": "stp_…", "seq": 1, "kind": "tool", "label": "…", "startedAt": "…", "endedAt": "…",
               "attributes": { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "calendar.create",
                               "gen_ai.usage.input_tokens": 0 }, "input": { … }, "output": "…" } ],
  "children": [ /* helper runs, same shape */ ],
  "frames": [ { "seq": 3, "at": "…", "stepId": "…", "file": "frames/3.jpg" } ]
}
```

- Step attributes use the OpenTelemetry GenAI semantic conventions' names where one exists (`gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.*`, `gen_ai.tool.name`). Mapping to OTLP spans later is then mechanical; OTLP export is a follow-up, not in this plan.
- With frames, the export is a `.zip` holding `trace.json` and `frames/`.
- The Markdown export is a readable summary: the header, one line per step with its duration, the failure diagnosis, and receipts. It's for pasting into an issue or a message.

## 5. Plan

Four workstreams with disjoint files. T1 and T4 start together. T2 and T3 start when T1's protocol and UI data layer have merged; they can build against fixtures earlier.

### 5.1 Workstreams

#### T1: run store, protocol and the UI data layer (#660)
- **Owns:**
  - `packages/protocol/src/{schemas/runs.ts, methods/runs.ts}` and additive fields in `schemas/threads.ts`, `schemas/tools.ts`, `schemas/integrations.ts` and `events.ts`
  - `packages/db` (the `run_steps` table, migration, `repos/run-steps.ts`; `tool_payloads` writes)
  - `packages/agent-core/src/loop.ts` (step ids, helper run ids, `onSubagentEvent` emission)
  - `packages/tasks/src/worker.ts` and `packages/scheduler` (`AutomationRun.runId`)
  - `apps/gateway/src/{session/controller.ts, handlers/runs.ts, retention.ts, compose/*}` (the run sink, progress forwarding, frames for computer use)
  - `packages/ui/src/data/{store.ts (run.* cases), runs.ts (hooks)}`, `packages/ui/src/fixtures/runs.ts` and `data/mock-gateway.ts` (`runs.*` handlers)
  - the Settings → Data controls rows (`data.reasoningRetentionDays` new; `data.replayRetentionDays` wired, with Off and 1 day)
- **Brief:**
  > You own the run store and protocol for Psyche's run trace. Read docs/design/run-trace-2026.md (§2, §4, §5) in full, and docs/04-data-model.md §2, §11, §12. Add, additively, the `RunStep` schema, the new `Run` fields, the `runs.*` methods (get, steps, list, step, frames, frame, export, delete) and the `run.step` event; bump the protocol minor version and regenerate `generated/`. In the Gateway, write `run_steps` for every run (chat, task, automation, helper) from one sink: thinking steps reuse the `chat.reasoning` stepId, tool steps get `stp_` ids carried on `ToolCall.stepId`, ToolUpdate progress is forwarded (throttled 4/s), helper runs get their own `runs` rows with `parentRunId`, task runs write `runs`/`tool_calls`/`run_steps` and publish `run.updated`/`run.step`, `AutomationRun` gains `runId` and `usage`, `usage` rows gain `stepId`, `memory.file.changed` gains `runId`/`stepId`, tool payloads are stored in `tool_payloads` (1 MB cap), computer-use screenshots become run frames. Keep thinking text for the new `data.reasoningRetentionDays` (default 7) and frames for the existing `data.replayRetentionDays` (wire it; default 7; add Off and 1 day) in `retention.ts`; redact everything at write with the one `SecretRedactor`. Implement `runs.export` (`psyche-trace+json` v1 with OTel GenAI attribute names, and Markdown). In packages/ui, add the `run.*` store cases, `data/runs.ts` hooks (`useRun`, `useRunSteps`, `useRunsList`, `useRunStep`, `useRunFrames`), `fixtures/runs.ts` (a done run with a parallel group and a helper, a failed run with a retry, a live run, an automation with 10 past runs) and MockGateway handlers so stories can script live runs. Every new string goes through `t()`. Run `vitest --maxWorkers=1` only for the packages you touch, and typecheck only those. Don't run the Electron e2e or local models. Don't touch `~/.psyche` or `/Applications/Psyche.app`.
- **Definition of done:**
  - Protocol tests cover every new schema.
  - A Gateway integration test runs a scripted loop (thinking, a parallel group, a helper, a retry, an approval) and asserts the steps, their ids and their order.
  - There are retention and redaction tests.
  - `runs.export` round-trips.
  - No UI changes beyond the data layer and the two Data controls rows.

#### T2: steps in the chat (#661)
- **Owns:**
  - `packages/ui/src/chat/RunStepLog.tsx` and a new `chat/steps/**`
  - `packages/ui/src/blocks/ToolRun.tsx` (the summary row) and the run-log mount in `chat/Thread.tsx`
  - `messages/chat.ts` keys `chat.steps.*`
  - `Chat.stories.tsx` run stories, and tests
- **Brief:**
  > You own the chat column's steps for Psyche's run trace. Read docs/design/run-trace-2026.md §2, §3.1, §3.2, §3.7, §3.8 and docs/design/motion.md in full. Move `RunStepLog` onto T1's `useRunSteps(runId)` and finish its final form: status rows with live elapsed and final durations, parallel groups ("{n} at once"), one level of helper nesting, approval/question rows, frame thumbnails, Thinking steps that read retained text, label tense flips (`label` → `doneLabel`), repeats folded into one row, folding (5 visible, failures never fold), the stalled hint, and the condense into the summary row (side effects first from receipts: "Worked for … · sent 1 email · n steps"; failed and cancelled forms) that replaces the folded `ToolRun` row, with "Timeline ›" opening the agent sheet's Timeline (`view` command or the sheet's route). Use T4's primitives (`LiveDuration`, `StatusGlyph` morph, `StepRow`) and the motion table in §3.7, with every reduced-motion form. Stories: live run, parallel group, helper, approval wait, stalled, failed with retry, done summary (collapsed and expanded), incognito, reduced motion. Regenerate only the Chat baselines with `--workers=1`. Strings via `t()`; copy per docs/copy/voice.md. Run `vitest --maxWorkers=1` for packages/ui only. Don't run the Electron e2e or local models.
- **Definition of done:**
  - The stories above exist with baselines, and axe passes on them.
  - The live region announces only step starts and outcomes (a test).
  - No layout shift when the log condenses (a test on the summary row's anchor).

#### T3: Timeline and Activity in the agent sheet (#662)
- **Owns:**
  - `packages/ui/src/agent/**` (`ActivityPanel` → Needs you, Now, Next up and Recent; the new `agent/timeline/**`: `TimelineView`, `RunHeader`, `Waterfall`, `StepInspector`, `FrameViewer`, `Scrubber`, `FailureBanner`)
  - the sheet's Timeline route in `apps/web/src/compose/PsycheApp.tsx` (`agentRoute` only)
  - `messages/screens.ts` keys `agent.timeline.*` and `agent.activity.*`
  - their stories and tests
- **Brief:**
  > You own the Timeline and Activity for Psyche's run trace. Read docs/design/run-trace-2026.md §2, §3.1, §3.3–§3.8 and redesign-2026.md §3, §5.7, §8 in full. Build the Timeline in the agent sheet: the run header with facts and the failure banner (what happened / what Psyche did / what you can do), the waterfall (`treegrid`, kind colours, parallel brackets, helper folding, idle-gap breaks, per-attempt segments, hatched wait and queue segments, roll-ups with "—" for unknown, zoom, time-range selection) and the searchable List view (⌘F over every step, folded ones included), the step inspector (Overview, Input, Output, Timing, Cost, Frames; redaction tokens; copy), the frame viewer with action overlays, the scrubber with replay (1×/4×/16×, skip waits, stop at failures, click-a-step to jump with later steps dimmed, Live and Back to live), a failed task opening on its failed step, the keyboard map in §3.3, and Export (calls `runs.export`, saves through the platform). Turn Activity into Needs you / Now / Next up / Recent with live sparklines and honest usual durations, opening Timelines; the task detail's action log moves into the Timeline. Use T1's hooks and fixtures and T4's primitives. Stories: done, running (scripted), failed with banner, helper unfolded, replay mid-scrub, frames, expired detail, empty Activity, compact web. Regenerate only the Agent baselines with `--workers=1`. Strings via `t()`. Run `vitest --maxWorkers=1` for packages/ui and apps/web only. Don't run the Electron e2e or local models.
- **Definition of done:**
  - Keyboard tests cover the §3.3 map.
  - Axe passes on every story.
  - Replay at a given time renders the expected steps (a pure-function test).
  - The waterfall renders 2,000 steps at 60 fps or better: rows are virtualised, measured with the fps probe in a story.

#### T4: motion and primitives (#663)
- **Owns:**
  - `packages/ui/src/motion/**`
  - `packages/ui/src/components/{status.tsx, steps/**, timeline/**, json-view.tsx, filmstrip.tsx, sparkline.tsx}`, with `Sparkline` moved from `shell/UsageFooter.tsx` and re-exported
  - `docs/design/motion.md` §4.9
  - `messages/design.ts`
- **Brief:**
  > You own the motion and primitives for Psyche's run trace. Read docs/design/run-trace-2026.md §3.2–§3.7 and docs/design/motion.md in full. Add to the kit: `StatusGlyph` with the step kinds and the morph (crossfade, ✓ scale on `spring.micro`), `LiveDuration` (1 Hz, tabular, `m:ss` while running and rounded when done, one shared ticker for every instance), `StepRow` (glyph, label with the active shimmer, target, duration; disclosure slot), `TimeAxis`/`Bar`/`Playhead` timeline primitives (transform-only bar growth, idle-gap break), a `JsonView` (collapsible, redaction tokens rendered as chips, copy), a `Filmstrip` (lazy thumbnails, current outline), and a live `Sparkline` (bucket slide-in on `duration.medium`, 1 Hz redraw cap). Write motion.md §4.9 from the run-trace §3.7 table, with each reduced-motion form, and extend `motion-tokens.test.ts`. Stories in Primitives for each, in light, dark, high contrast and reduced motion. Regenerate only the Primitives baselines with `--workers=1`. Strings via `t()`. Run `vitest --maxWorkers=1` for packages/ui only. Don't run the Electron e2e or local models.
- **Definition of done:**
  - One ticker drives all `LiveDuration`s (a test).
  - The bar growth is transform-only (a test on styles).
  - Contrast passes for the kind colours in both appearances.
  - Primitives stories have baselines.

### 5.2 Order and shared files

1. T1 (protocol and data layer) and T4 (primitives) run in parallel.
2. T2 and T3 start when T1's protocol PR merges. Both build against `fixtures/runs.ts`, and they own disjoint folders.
3. T1 lands the Gateway sink in a second PR, behind no flag: the steps are additive, and old clients ignore `run.step`.
4. The integrator merges T2 and T3. The docs/06 amendment (Activity §3.14, chat anatomy §3.2) comes with T3.

**Shared files:**
- **`packages/ui/src/index.tsx`:** each workstream adds its own export lines.
- **`PsycheApp.tsx`:** T3 touches only `agentRoute`.
- **`data/store.ts`:** T1 only; T2 and T3 read through hooks.
- **i18n:** T2 uses `chat.ts`, T3 `screens.ts`, T4 `design.ts`, and T1 `settings.ts` plus the protocol-facing labels.

### 5.3 Fixtures, stories and baselines

Every PR adds the fixtures its stories need to `fixtures/runs.ts` (T1 creates it; the others append) and the stories listed in its brief, then regenerates only its own baseline group with `--workers=1`. Scripted live runs use `MockGateway.emit` (`run.step` and `run.updated`) on a story timer, so live states are reproducible, and the visual suite captures them at a fixed `STORY_NOW`.

### 5.4 Risks

| Risk | Mitigation |
| --- | --- |
| Event volume during a fast run floods the renderer | Gateway coalescing (§4.4); client batching per animation frame; a virtualised waterfall |
| Storing reasoning and frames surprises the owner | Defaults are stated in onboarding's privacy step and Settings → Data controls; Off restores today's behaviour; incognito never stores |
| Secret leakage through new stored fields | One redactor at write; export re-redacts; T1 adds a redaction test per stored field |
| Two run models (chat vs task) drift again | One Gateway sink for both; `task_actions` becomes a view over steps in a follow-up |
| Helper id change breaks existing helper threads | Old `:sub:` ids stay readable; only new runs get ULIDs |
| Waterfall cost on long tasks | Virtualise rows; idle-gap breaks; 2,000-step cap with folding |
| "Run" leaking into copy | The §3.1 glossary amendment and the i18n check's word list |

## 6. Decisions the owner should confirm

1. **Keep Thinking for 7 days by default** (§4.3), instead of #633's transient. Off is one setting away.
2. **Keep the frames Psyche looked at for 7 days by default** (§4.3). Today only opt-in browser recordings keep frames.
3. **The names "steps", "Timeline" and "helper"** in the UI (§3.1). "Run" and "trace" stay internal.
4. **Activity becomes mission control** (§3.6), and the task detail's action log moves into the Timeline.
5. **No OTLP export in this plan.** The export uses OTel GenAI attribute names so it's easy to add later.

## Sources

The sources for §1 are in [research/agent-traces.md](research/agent-traces.md#sources). The code facts in §4.1 are from the repository at `41009f99`.
