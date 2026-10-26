# Agent run traces: how products present them

Research for the Psyche run-trace design spec. Compiled 2026-10-25 from web sources only (no builds, no repo changes).

**How to read this**

- Bracketed numbers like `[12]` point to the numbered **Sources** list at the end. Every factual bullet carries at least one.
- Source quality, best first: official docs, then changelogs and engineering blogs, then reputable press and reviews. Third-party claims are marked *(3p)*.
- Dates: most sources are from 2025–2026. Older material is flagged *(older: year)*.
- "Not documented" means I could not find the behaviour in the sources I checked. It does not mean the product lacks it.
- The same ten facets are used for every product: **Step**, **Hierarchy**, **Time**, **Failure/retry**, **Live**, **Inspector**, **Replay**, **Cross-run**, **Export/share**, **Keys**.

---

## 1. Claude Code (CLI, desktop, web)

- **Step**
  - The unit is a tool call or an assistant message.
  - MCP calls collapse by default into one summary line such as `Called slack 3 times` [1].
  - In desktop "Normal" view, tool calls are collapsed into summaries while text responses show in full [2].
- **Thinking**
  - Without `showThinkingSummaries`, the API redacts thinking blocks and the CLI shows a "collapsed stub". With it set, `Ctrl+O` expands the full summaries [5].
  - Desktop has three view modes, cycled with `Ctrl+O` [2]:
    - **Normal**: collapsed tools, no thinking.
    - **Thinking**: collapsed tools plus thinking.
    - **Verbose**: every tool call, file read and intermediate step.
  - The Thinking mode appears only after the session has produced thinking [2]. An older "Summary" mode was removed [2].
- **Hierarchy (subagents)**
  - Running subagents appear in a panel below the prompt. In the terminal, nested subagents render as a tree, and rows with descendants show a `(+N)` count [3].
  - The default row format is `name · description · token count`. It can be rewritten with the `subagentStatusLine` hook, for example to show context %. [5]
  - Rows are removed immediately on success, and the footer shows `/tasks to see subagents` for 30 s. On failure or stop, the row stays for 30 s and can be cleared with `x` [3].
  - `/tasks` lists subagents with their model and effort. `Enter` opens a subagent's own transcript, and you can type into it to steer it [3].
  - Desktop has dedicated "tasks" and "subagent" panes [2].
- **Todo list (task list)**
  - Claude's checklist shows pending, in-progress and complete indicators. `Ctrl+T` toggles it, and it shows up to 5 items at a time [1].
  - The list persists across compaction and can be shared across sessions via `CLAUDE_CODE_TASK_LIST_ID` [1].
  - Newer builds use structured `TaskCreate/TaskUpdate/TaskGet/TaskList` tools instead of `TodoWrite`. Items move from pending to in_progress to completed [7].
- **Time and tokens**
  - After each turn the CLI prints the duration, for example "Cooked for 1m 6s · done 6:05 PM". It can be toggled with `showTurnDuration` [5].
  - The spinner shows a rotating verb ("Accomplishing", "Baking"…), customisable via `spinnerVerbs`, plus rotating tips [5].
  - `prefersReducedMotion` reduces the spinner, shimmer and flash animations [5].
  - Subagent rows carry token counts [5].
- **Away recap**
  - After at least 3 minutes away with the terminal unfocused, the CLI shows a one-line "recap" of the session, capped at 400 characters. It needs at least 3 turns and is never shown twice in a row [1].
  - In agent view, each background session row gets a one-line summary from a Haiku-class model. It refreshes at most every 15 s from recent output while the session is working, and is rewritten every few minutes during long turns [4].
- **Status vocabulary**
  - Agent view uses these states [4]:
    - **Working**: animated.
    - **Needs input**: yellow.
    - **Idle**: dimmed.
  - Groups are ordered "Ready for review", then "Needs input", above "Working" and "Completed". Overflow folds into `… N more` [4].
- **Failure/retry**
  - Failed subagent rows persist for 30 s [3].
  - Usage-limit waits show two status lines ("limit resets 3:45pm" / "Continuing automatically at 3:45pm · esc to cancel"). Auto-continue re-arms at most twice [1].
- **Live**
  - Output streams into the transcript.
  - `Esc` interrupts but keeps the work done so far. Messages typed during a turn are queued [1].
  - `Ctrl+B` sends a running command or agent to the background [1].
- **Inspector**
  - The transcript viewer (`Ctrl+O`) shows detailed tool usage, plus a timestamp and model on each assistant message [1].
  - In fullscreen mode, `[` dumps to native scrollback for searching and `v` opens the transcript in `$EDITOR` [1].
- **Replay**
  - There is no visual scrubber.
  - Transcripts are JSONL on disk, and subagent transcripts live under `…/subagents/agent-{id}.jsonl` [3].
- **Retention**: `cleanupPeriodDays` defaults to 30 days [3].
- **Cross-run**: `claude agents` (agent view) shows one row per background session. `Space` opens a "peek" panel with the latest output or the pending question, and you can reply inline [4].
- **Export/telemetry**
  - Claude Code exports OTel metrics and events, plus beta distributed traces that link each prompt to its API requests and tool executions [6].
  - Spans **redact prompt text, tool inputs and tool content by default**. You opt in with `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS` and `OTEL_LOG_TOOL_CONTENT` [6].
  - Content attributes are truncated at 60 K UTF-16 units by default [6].
- **Keys**: `Ctrl+O` transcript, `Ctrl+T` todo list, `Ctrl+B` background, `Esc` interrupt, `{`/`}` jump between prompts, `?` help [1].

## 2. Cursor (Agent, Background/Cloud Agents)

- **Step**
  - A tool call: search, read, edit, shell, browser and similar tools. There is no cap on tool calls per task [8].
  - "Compact" chat mode (1.4) hides tool icons and collapses diffs by default [11].
- **Plan**
  - Since 1.2, the agent writes structured to-do lists with dependencies. They are shown in chat and mirrored to Slack, and updated as work progresses [10].
- **Checkpoints**
  - Created before significant changes. You can click any checkpoint in the chat timeline to preview files at that point, then restore. Restoring does not remove messages [8].
- **Queue/steer**
  - Queued messages appear in order below the active task and can be reordered by drag [8].
  - "Send now" steers at the next tool call [8].
  - In 1.4, `⌘+Enter` interrupts and sends immediately, while `⌥+Enter` queues [11].
- **Hierarchy/parallel**
  - The left sidebar lists all agents, foreground and background. Clicking a background agent lets you peek into its remote machine (1.4) [11].
  - A "Project" uses a coordinator agent that delegates to other agents [8].
- **Live and takeover**
  - Cloud agents run in their own VM. "Remote desktop control" lets you take the desktop over and release it [9].
- **Artifacts**
  - Agents produce screenshots, videos and logs that show what changed and how the change was verified [9].
  - Cursor Cloud MCP exposes transcripts, run events and setup logs [9].
- **Share**
  - Agent URLs give teammates a read-only view of the conversation, diffs and artifacts. Admins can enable "team follow-ups" [9].
  - Agents are reachable at cursor.com/agents, on iOS, and as an Android PWA [9].
- **Time/tokens**: per-step timing and token display are not documented in the pages I checked [8][9].

## 3. Devin (Cognition)

- **Step**
  - A "progress update" in the worklog. Shell commands are linked to the update they belong to [12].
  - "All shell commands, code edits, and browser activity will be logged in one unified view" (the Progress tab) [12].
- **Panes**
  - **Shell**: command history with output previews and copy actions. Terminals can be toggled from read-only to writable so you can take over [12].
  - **IDE**: VS Code with live edits and a diff view [12].
  - **Browser** (labelled **Computer** when Computer Use is on): you can interact with it directly [12].
  - A read-only **side chat** (`/btw`) sits next to the worklog [12].
- **Time navigation**
  - Clicking a command in Command History **jumps the session to that point**. Commands that run later are greyed out, which acts as a time-travel cursor [12].
  - I found no documented "timelapse" or scrubber [12].
- **Post-run analysis ("Session Insights")** [13]
  - Generated on demand from the ⋯ menu.
  - Shows an "Issue Timeline" colour-coded red (high-impact issue), yellow (medium), white/grey (significant event) and green (value provided). Events tied to an issue are bold.
  - Includes ACU usage, a session size from XS to XL (L/XL flagged unhealthy), a task category, and an "Improved Prompt" with hover-to-explain diffs.
- **Keys**: IDE only, `Cmd+K` and `Cmd+I` [12].

## 4. Manus

- **Model**
  - A "virtual colleague with its own computer": a sandbox VM with a browser, file system and the ability to install software [17].
  - Launched March 2025. An early review noted crashes and overload but called it "highly intuitive" [18].
- **Live**
  - "You see everything Manus is doing in real-time" in the Cloud Browser [14].
  - **Take Over**: Manus prompts you, with a notification, to take the browser over for CAPTCHAs and MFA, then hand control back [14].
- **Parallelism ("Wide Research")**
  - The main agent decomposes a task into independent sub-tasks, deploys one agent per item in parallel (each with a fresh context), then synthesises the results [15].
- **Replay/share**
  - Shared task URLs (`manus.im/share/…`) with `?replay=1` play the task back. The docs link several such replays [15].
  - "Collab" invites other people to watch the task "in real-time as it develops" and to prompt it [16].
- **Step list/inspector**: the step-list layout and per-step inspector are not described in the official docs I could reach. Treat details from screenshots and reviews as unverified.

## 5. OpenAI: Agents SDK / Agents API tracing, Operator, ChatGPT agent

**Tracing (developer surface)**

- **Model**
  - Session, then turn, then trace (one turn), then spans [20].
  - The SDK wraps each run in a trace named "Agent workflow". Default span kinds are agent, generation, function (tool), guardrail, handoff, task/turn, transcription/speech and custom [19].
  - Task and turn spans can be switched off for a flatter tree (`include_task_and_turn_spans`) [19].
- **Dashboard (Logs → Agents)**
  - Search logs, then filter by model, status or date [20].
  - The session summary shows status, model, start, last activity, turn count and tokens [20].
  - Expanding a turn reveals the steps grouped under the root agent or subagent [20].
- **Time**
  - The timeline "shows the order of the steps and which ones overlap", with **Zoom in** and **Fit timeline** controls [20].
  - An agent span's duration includes its children. Overlapping subagents are drawn in parallel [20].
- **Tokens**
  - Per-agent **Usage** excludes its subagents. "A blank value or `null` means the count is unknown. It does not mean the agent used zero tokens" [20].
  - Traces are built **after** a turn ends, so the answer can appear before the trace. Live progress comes from separate session events [20].
- **Failure**: each span shows its outcome status and error details. For MCP calls, the response sits in **Call** and the **Result** panel can be empty [20].
- **Redaction**
  - `trace_include_sensitive_data` (default True) controls whether generation and tool spans store inputs and outputs [19].
  - Redaction must live in the same exporter as delivery, because a separate redaction processor that fails won't block the other exporters [19].
  - Tracing is unavailable under Zero Data Retention [19].
- **Export**
  - `GET /v1/agents/sessions/{id}/traces` returns **OTLP JSON**, paginated with `has_more` [20].
  - About 30 third-party processors are supported, including Langfuse, LangSmith, Braintrust and Datadog [19].

**Operator** *(older: Jan 2025)*

- Operator works from screenshots in a remote browser [21].
- **Takeover mode** applies to logins and payments, and in it Operator "does not collect or screenshot" what the user enters [21].
- It asks for confirmation before significant actions [21].
- **Watch mode** requires supervision on sensitive sites such as email [21][22].
- A prompt-injection monitor pauses execution when it sees suspicious content [22].

**ChatGPT agent** *(Jul 2025; mostly 3p)*

- Each chat gets a cloud VM [25].
- Reviewers describe watching the run live and taking control at any time [23].
- After the run there is "a full video recording you can pause and replay" plus "a detailed text timeline showing the reasoning behind each step", commands and file operations [23].
- An on-screen box narrates the action the agent is attempting [24].
- Reviewers say runs of 10–30 minutes are common and that long replays are boring to watch [23].
- In Atlas's agent mode, the agent acts in your browser and reports back in a side panel [26].

## 6. Perplexity (Labs, Comet, Computer)

- **Labs (mid-2025, 3p)**
  - Has **Tasks**, **Assets** and **App** tabs [30].
  - The Tasks pane shows the order of the research steps and how data flowed through scripts and files into the result [30].
  - Assets lists downloadable outputs [30].
- **Search/Comet step display**
  - Steps appear "in a tab above the results pane", in both the app and the Comet browser [31].
- **Comet assistant**
  - Works across multiple tabs on longer jobs [29].
  - Asks approval before acting in the browser, and remembers that choice for the session [29].
- **Computer (launched Feb 2026)**
  - Decomposes the requested outcome into tasks and subtasks and creates subagents. Routes them to different models [27].
  - Each run has review checkpoints when human input is needed and runs asynchronously [28].
  - The official UI for subagent progress is not documented in sources I could verify.

## 7. Replit Agent

- **Step = checkpoint**
  - The agent auto-creates checkpoints at milestones. Each one is a full snapshot of code, files, AI conversation context and, optionally, the dev database [32].
  - Each checkpoint carries an AI-written description, a timestamp, the scope of what changed, and **per-checkpoint billing** [32].
- **Timeline**
  - The history icon opens a timeline of checkpoints. Checkpoints also appear as Git commits [32].
  - "Rollback to here" asks you to confirm first [32].
  - You can roll forward again. New work after a rollback creates an **alternate branch** of history [32].
- **Progress**: users "follow progress in chat" until the agent presents its artifact [33].
- **Inspector/time/keys**: not documented in the sources I checked.

## 8. Zapier Agents

- **Cross-run view**
  - "Activity" exists per agent, per pod, and across all agents [34].
  - Each run row shows status, the apps used, and when it ran [34].
  - Runs can be pinned to the top [34].
- **Run panel**: expanding a run (down arrow) shows how the agent interpreted and carried out the instructions [34].
- **Delete**: a run is deleted via "Delete chat". Deleting an agent deletes all of its activity [34].
- **Not documented**: per-step timing, retries, export.
- **Contrast**: classic Zap History has per-step run detail, a different and more structured model [34].

## 9. Langfuse, LangSmith, Braintrust (LLM observability)

### Langfuse

- **Step**
  - Every step is an "observation" (Langfuse's word for a span). Observations nest inside a trace, and traces can group into sessions [41].
  - Observation types are event, span, generation, agent, tool, chain, retriever, evaluator, embedding and guardrail [40].
- **Views**
  - Tree/timeline toggle with search by type, ID or name, and optional colour coding (Mar 2025) [37].
  - The timeline view is meant for latency bottlenecks and parallel steps *(older: Jun 2024)* [36].
  - Agent graphs are inferred from timing and nesting (GA Nov 2025). They have an "Aggregated" view and an "as it ran" view [38][39].
  - The **Log View** concatenates every observation so you "skim every agent step just by scrolling" and can `Cmd+F` across the whole trace [38].
- **Tools**: each generation lists all the tools available to the LLM, numbered, so called tools can be checked against what was offered [38].
- **Redaction**: `mask` / `mask_otel_spans` hooks redact data client-side before export [42].
- **Retention**
  - Retention is set per project, minimum 3 days, and enforced by a nightly deletion job [43].
  - With no policy set, data is kept indefinitely [43].
- **Ingest**: built on OpenTelemetry [41].

### LangSmith

- **Step**: a "run" in a trace tree [44].
- **Tokens and cost** [44]
  - The trace tree shows the trace total, aggregated values for each parent run, and a breakdown for each child.
  - Input tokens are split into cache reads and image tokens. Output tokens include reasoning tokens.
  - An "Other" bucket covers tool and retrieval costs.
  - Hovering shows the breakdown.
- **Threads**
  - Traces are grouped into threads by `thread_id` / `session_id` metadata [45].
  - Child runs without that metadata drop out of thread filtering and cost totals [45].
- **Redaction**: `LANGSMITH_HIDE_INPUTS` / `LANGSMITH_HIDE_OUTPUTS`, per-client `hide_inputs` / `hide_outputs`, and regex or function anonymizers [46].
- **Retention**
  - Base 14 days, extended 400 days [47].
  - Traces upgrade to extended automatically when they receive feedback or enter an annotation queue [47].

### Braintrust (docs dated Oct 2026)

- **Span types**: eval, task, llm, function, tool, score, review, automation and others [48].
- **Layouts** [48]
  - **Spans**: indented tree. Each row shows duration, total tokens, estimated cost and cache hit rate inline. Cost rolls up from children.
  - **Thread**: the conversation in chronological order.
  - **Timeline**: bars can be scaled by duration, tokens or cost. A token-distribution overview shows uncached, cached-read, cache-write and output tokens.
- **"Worked" block (new thread view)** [48]
  - Each user turn collapses all of its LLM and tool calls into a **Worked** block showing how long the turn took and how many LLM calls, tool calls and errors it had.
  - Sub-agent work nests under the step that started it.
  - A **Compaction** divider marks where the context was compacted.
  - A left rail lists the turns, and `W` expands everything.
- **Inspector** [48]
  - Tabs: Messages (errors are shown in place next to the input and output that produced them), Details, Review, Activity, Raw.
  - Each field has view modes: Pretty, JSON, YAML, Tree, LLM, LLM Raw.
  - `Cmd+F` searches within the trace.
- **Share/keys** [48]
  - Share links can be made public. Stable span URLs take a `tvt=` parameter to pick the view.
  - `Shift+F` for fullscreen, `\` for the tree.
- **CLI**: `bt view waterfall` prints offset, duration, model, tokens, cost and cache per span. The TUI uses `t` to switch between spans and thread, and `/` to search [49].

## 10. Temporal Web UI and Inngest (durable workflows)

### Temporal

- **Step**: about 40 event types make up the execution's Event History [50].
- **History views** [50]
  - **Timeline**: chronological or reverse, with a summary.
  - **All**: every event.
  - **Compact**: logical groups of Activities, Signals and Timers.
  - **JSON**: the raw history.
- **Timeline rows**
  - Scheduled, Started and Completed collapse into **one Activity row that spans its duration**. Green means completed and red means failed [52].
  - Retrying activities show a retry icon with the **current attempt number**. Tooltips show exact start, end and duration [52] *(older: Oct 2023)*.
- **Live and filters (Aug 2024)** [51]
  - Events update live, and live updates can be **paused** while investigating.
  - Filter by event type and "Pending and Failed Events Only".
  - Shows a pending activity's current attempt and **when the next retry will occur**.
  - Child-workflow timelines can be explored inline.
- **Header**: start, close and duration, run ID, parent, state transitions, and billable actions. Results show only once the workflow finishes [50].
- **Export/actions**
  - The full event history downloads as JSON [50].
  - Reset, Terminate, Signal and "Start Workflow Like This One" are available from the UI [50].

### Inngest

- **Layout**: two resizable panes, a waterfall on the left and details on the right. The header shows duration (queued to ended), timestamps, and Rerun / Cancel / Invoke [53].
- **Bar encoding** [53]
  - Status colours: green ok, red failed, grey cancelled.
  - Waits (`step.sleep`, `waitForEvent`) are grey bars.
  - **Compound bars** show a grey queue-delay segment followed by an execution segment.
  - Expanding a bar splits it into "Inngest" queue time and "Your server" time.
  - Tooltips give duration, delay, and start/end to the millisecond.
- **Zoom**: a **time brush** narrows and pans the window, and a reset button returns to 0–100% [53].
- **Retries** [53]
  - Each attempt is a **separate span**, so attempts can be compared.
  - The detail header shows an "Attempt N" badge coloured by outcome.
- **Inspector**
  - Tabs: Input, Output, Error (auto-selected when a step failed), Headers, Metadata [53].
  - Includes step-type-specific fields such as timeout and the matched event ID [53].
- **Replay** [54]
  - **Rerun** starts from the original trigger.
  - **Rerun from step** reuses the memoized earlier steps, re-executes from the selected step, and lets you edit that step's input.
  - **Bulk Replay** reruns by function, time range and status.

## 11. Xcode Instruments (macOS-native reference)

*(Help pages are undated or older, roughly 2017–2019. They are the macOS design reference, not agent-specific.)*

- **Tracks and timeline**
  - Each instrument, CPU core or thread gets its own **track** in a read-only timeline [55].
  - You can zoom, pin tracks to the bottom, use a filter bar (All / CPUs / Instruments / Threads), and drop **flags** to mark points of interest [55].
- **Inspection range**: dragging across the timeline filters the detail pane to that span. View > Clear Inspection Range resets it [55].
- **Detail and inspector**
  - The detail pane switches between Summary, Call Tree and Console [55].
  - The **extended detail** inspector on the right shows the selected item's stack trace and recording time, and can collapse system frames [56].
- **Signposts**
  - `OSSignposter` intervals (begin/end pairs) and point events render as rows per subsystem and category, with a table below [57].
  - This maps closely to "steps as intervals, events as ticks".

## 12. Linear (activity timeline and Agent sessions)

- **Issue activity (Apr 2025)**: Linear now "group[s] similar consecutive events and collapse[s] older activity between comment threads" to reduce clutter [58].
- **Agent sessions** (Linear's agent platform)
  - **Session states**, visible to users: `pending`, `active`, `error`, `awaitingInput`, `complete`, `stale` [59].
  - States are derived automatically from the last emitted activity [59].
- **Activity types** [59]
  - `thought`
  - `action`: carries an action, a parameter and an optional result, so "Searching" becomes "Searched" when it completes.
  - `elicitation`: asking the user for input.
  - `response`
  - `error`
  - `prompt`: user follow-ups.
- **Ephemeral activities**: only `thought` and `action` can be **ephemeral**. Ephemeral activities are "displayed temporarily, and will be replaced when the next activity arrives". This is how live status text works [59].
- **Agent Plan**: a session-level checklist (`content` + `status`), replaced wholesale on each update (tech preview) [59].
- **Responsiveness rules** [60]
  - The agent must emit a `thought` within **10 s**, or it is shown as unresponsive.
  - It can keep emitting for up to 30 min before the session goes "stale", which is recoverable.
  - A final `response`, `elicitation` or `error` also posts a comment on the issue.
- **External URLs**: `externalUrls` adds an "Open" button that deep-links to the provider's own dashboard, a progressive-disclosure hand-off [59].

## 13. GitHub Actions run logs

- **Structure**: run, then jobs (opened from a list or the **visualization graph**), then steps. GitHub adds "Set up job" and "Complete job" steps automatically [61].
- **Time**: each step shows how long it took [61].
- **Failure**: steps are collapsible, and **failed steps auto-expand** [61].
- **Search and links**
  - "Search logs" only searches *expanded* steps [61].
  - Clicking a line number gives a permalink to that line [61].
- **Grouping**: `::group::title` … `::endgroup::` creates an expandable section inside a step's log [62] *(older doc version)*.
- **Export**
  - "Download log archive" is in the gear menu. For a partially re-run workflow it contains only the re-run jobs [61].
  - The CLI `gh run view --log-failed` shows only failed steps [61].

## 14. Research and essays (agent UX, streaming, waiting)

- **Show the plan (Anthropic, Dec 2024)**: one core principle reads "Prioritize transparency by explicitly showing the agent's planning steps" [63].
- **Stream of Thought pattern (shapeof.ai)** [31]
  - The trace lives in a bounded, collapsible box with live and review modes.
  - It comes in three forms: human-readable plans, execution logs, and compact summaries.
  - Model each step as a state: queued, running, waiting for approval, error, retried, completed.
  - Keep plan, execution and evidence "separate but synchronized".
  - Keep short chats minimal and show more on long or expensive tasks.
- **Magentic-UI (Microsoft Research, 2025)** [64][65]
  - Co-planning: the user edits the plan before execution.
  - Action guards: approval before irreversible steps, at a frequency the user chooses.
  - Sandboxed execution.
  - Co-tasking, multi-tasking and long-term memory.
- **Response-time limits (Nielsen)**: 0.1 s feels instant, 1 s keeps flow, 10 s keeps attention. Beyond 10 s, show a percent-done indicator and a way to interrupt [66] *(older: 1993, updated 2014)*.
- **Perceived progress (Harrison et al., UIST 2007)**: progress-bar behaviour measurably changes how fast a process feels, and real progress is non-linear [67] *(older: 2007)*.
- **Product evidence for "alive" waiting**
  - Claude Code's spinner verbs and tips, with a reduce-motion setting [5].
  - Linear's ephemeral `thought`/`action` lines replace one another instead of piling up [59].
  - Claude Code and agent view one-line LLM summaries refresh at most every 15 s [4].
- **Review fatigue**: watching full-length video replays is "pretty boring" once the novelty wears off [23]. This favours step-indexed replay over linear video.

---

## Synthesis

### (a) Patterns to adopt

1. **One step model, several views.**
   - Braintrust (Spans / Thread / Timeline) [48], Langfuse (tree / timeline / log / graph) [37][38] and Temporal (Timeline / All / Compact / JSON) [50] all render the same span data several ways.
   - Psyche should store one span tree and render a "story" view and a "debug" view from it.
2. **Collapse each turn into a "Worked for 1m 12s · 6 tool calls · 1 error" block.**
   - Braintrust's **Worked** block [48], Claude Code's "Cooked for…" footer [5] and ChatGPT agent's post-run summary [23] converge on this.
   - Expanding the block reveals the steps.
3. **Status as a small, closed vocabulary with colour and motion.**
   - Linear: pending, active, awaitingInput, error, complete, stale [59].
   - Claude Code: Working (animated), Needs input (yellow), Idle (dimmed) [4].
   - Temporal and Inngest: green for done and red for failed. Inngest adds grey for cancelled runs and for waits [52][53].
   - "Needs you" always sorts first [4].
4. **Ephemeral live line plus durable log.**
   - Linear's ephemeral thought/action line is replaced in place [59].
   - Linear's "Searching → Searched" tense flip on completion [59] is a cheap, high-signal liveness cue.
5. **Retries are first-class.**
   - Inngest draws each attempt as its own span with an "Attempt N" badge [53].
   - Temporal shows the attempt count and the next retry time [51][52].
   - Never silently overwrite a failed attempt.
6. **Errors open themselves.**
   - GitHub auto-expands failed steps [61].
   - Inngest auto-selects the Error tab [53].
   - Braintrust shows errors next to the input and output that caused them [48].
7. **Waterfall with honest time.**
   - Draw queue or wait time distinctly from execution (Inngest compound bars [53]).
   - Overlap shows parallelism (OpenAI [20]).
   - Provide zoom-to-fit and a brush (OpenAI, Inngest [20][53]).
8. **Token and cost roll-ups with "unknown ≠ zero".**
   - Per-span tokens and cost roll up into parents (Braintrust, LangSmith [48][44]).
   - Show "—" for unknown, as OpenAI does [20].
9. **Inspector with format switch.**
   - Pretty, JSON and Raw views, plus Input / Output / Error / Metadata tabs (Braintrust, Inngest [48][53]).
   - Copy buttons and a permalink per step (Devin, GitHub [12][61]).
10. **Step-indexed time travel instead of video.**
    - Devin's "click a command to jump; later items greyed" [12].
    - Instruments' inspection range [55].
    - Replit's checkpoint timeline with rollback and branch [32].
11. **Rerun from step**, with editable input (Inngest [54]), for scheduled or background runs.
12. **Hand-off links.** Linear's `externalUrls` "Open" button [59] and Cursor's read-only agent URLs [9] give a one-click path from a summary to full detail.
13. **Redact by default and opt in to content.**
    - Claude Code OTel [6] and OpenAI `trace_include_sensitive_data` [19].
    - Masking happens client-side before export (Langfuse, LangSmith [42][46]).
    - Takeover inputs are never captured (Operator [21]).

### (b) Anti-patterns that make traces noisy

- **Every tool call at equal weight.** Claude Code collapses repeated MCP calls ("Called slack 3 times") [1], and Linear groups consecutive similar events [58]. Uncollapsed repetition is the most common source of noise.
- **Raw chain-of-thought dumped inline.** Claude Code redacts thinking to a stub unless the user opts in [5]. shapeof.ai warns against showing heavy detail in simple chats [31].
- **Full-length video as the only replay.** Reviewers find it boring [23], and it is not searchable. Make video, if any, secondary to a step list.
- **Plan and execution blurred.** shapeof.ai flags confusion between "proposed" and "completed" steps and unclear status [31].
- **Zero shown when tokens are unknown**, or a total that silently omits subagents. OpenAI explicitly separates these [20], and LangSmith notes threads undercount when child metadata is missing [45].
- **Ever-growing piles of status text.** Ephemeral activities [59] and rate-limited summaries (every 15 s or more) [4] avoid this.
- **Search that misses collapsed content.** GitHub's log search only covers expanded steps [61], whereas Langfuse's Log View enables full-trace `Cmd+F` [38].
- **Silent hangs.** Linear marks an agent unresponsive after 10 s without a first activity and stale after 30 min [60]. Nielsen's 10 s attention limit applies [66].
- **Animated avatars or decorative motion that conveys no state.** Motion should encode "working" only. Claude Code ships a reduce-motion option [5].

### (c) Recommendations for Psyche: non-technical owner by default, real debugger on demand

**Level 1: "Story" (default, in chat)**

- **Placement**: one compact **run card** per agent turn, in the chat flow.
- **While running**
  - A single live line in the present-progressive ("Reading your calendar…"), replaced in place as in Linear's ephemeral activities [59].
  - A subtle animated status dot, plus elapsed time once a run passes about 10 s [66].
  - Show the plan checklist (≤5 visible, as Claude Code does [1]) only when the agent made a plan of 3 or more steps.
- **When done**
  - The card collapses to "Worked for 1m 12s · checked 3 sources · sent 1 email" [48][5].
  - Verbs turn past tense ("Searched") [59].
  - Outputs and side-effects (messages sent, files changed, money spent) are listed above the fold. Read-only steps are folded away.
- **Needs you**
  - A yellow "Needs your input" state that pins the run to the top of any list [4].
  - Approvals are rendered inline, in the style of action guards [64].
  - Takeover inputs are never recorded [21].
- **Failure**
  - A plain-language one-liner ("Couldn't reach Gmail. Tried 3 times.") with **Retry** and **Show details**.
  - Never a stack trace at this level.
- **Vocabulary**: Queued · Working · Needs you · Done · Failed · Stopped. Colour plus an icon plus a word, never colour alone [4][59].

**Level 2: "Inspector" (on demand: "Show details", ⌥-click, or `⌘⌥I`)**

- **Layout**: an Instruments-style split view [55].
  - Left: the step tree with inline duration, tokens and cost. Parents roll up. Unknown values show as "—" [48][20].
  - Above or toggled: a waterfall timeline. Overlap shows parallel subagents. Waits and queue time are hatched or grey [53][20].
  - Right: the inspector, with tabs Input · Output · Error · Metadata · Raw JSON [53][48].
- **Toggles**: a Story/Steps/Timeline/Log segmented control. "Log" is a single searchable concatenation with `⌘F` over all content, including collapsed steps [38].
- **Retries**: each attempt is its own row with an "Attempt N" badge. Failed steps auto-expand and auto-select the Error tab [53][61].
- **Time travel**: clicking a step dims everything after it, Devin-style [12]. Drag across the timeline to set an inspection range that filters the tree [55].
- **Actions**
  - "Copy step as JSON", "Copy permalink", "Rerun from this step" (editable input) for idempotent steps only [54].
  - "Export run" writes OTLP JSON [20].
- **Privacy**
  - Secrets and tokens are masked at capture time, not at render time [42][19].
  - A per-run "Include message bodies" setting is off by default for connectors that hold personal data [6].
- **Thinking**: hidden by default and shown as a collapsible summary when present [5][2].

**Cross-run surface ("Activity")**

- A list grouped Needs you → Working → Done/Failed (Claude Code agent view [4]).
- Each row shows title, one-line summary, status, duration, cost and a relative time.
- Filters: Failed only and Needs you (Temporal's "Pending and Failed only" [51]).
- Default to a recent window and allow pinning runs to the top, as Zapier's Activity list does [34].

**Keyboard (macOS-native)**: `⌘F` search · `↑↓` steps · `←→` collapse/expand · `Space` peek · `⌘C` copy step · `⌘⌥I` toggle inspector · `Esc` stop.

---

## Data model notes

**OpenTelemetry GenAI semantic conventions (status: Development)**

- The conventions moved to their own repo; the opentelemetry.io page is no longer maintained [68][69].
- `gen_ai.operation.name` is Required. Well-known values: `chat`, `create_agent`, `invoke_agent`, `invoke_workflow`, `plan`, `execute_tool`, `retrieval`, `embeddings`, `text_completion`, `generate_content`, and memory operations [68].
- Span names: `create_agent {gen_ai.agent.name}`, `invoke_agent {gen_ai.agent.name}`. There are client vs internal span variants for remote vs in-process agents [68].
- There are also workflow, plan, execute-tool, load-skill and command-execution spans [68].
- `gen_ai.conversation.id` is conditionally required [68].
- Content attributes are **Opt-In**: `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`. They follow JSON schemas [68].

**OpenAI Agents SDK / Agents API**

- Trace fields: `workflow_name`, `trace_id` (`trace_<32 alnum>`), `group_id` (links a conversation), `metadata` [19].
- Span fields: `started_at`, `ended_at`, `trace_id`, `parent_id`, and typed `span_data` (agent / generation / function / guardrail / handoff / custom / task / turn / audio) [19].
- The hosted API adds session → turn → trace → span [20].
- Export is OTLP JSON [20].

**Langfuse**

- One observations table. The trace is the set of observations sharing a `trace_id`, and the trace-level `user_id`, `session_id`, tags and metadata are propagated to every observation [41].
- Ten observation types [40].
- Optional sessions group traces [41].
- Ingest is OTel-native [41].
- Retention: indefinite by default, or a per-project policy of 3 days or more [43].

**LangSmith**

- Runs form a tree, and threads are formed via `thread_id` / `session_id` metadata on **every** run [45].
- Cost needs `ls_provider` and `ls_model_name` plus token counts. Custom cost can be attached to non-LLM runs [44].
- Retention: 14 days (base) or 400 days (extended) [47].

**Braintrust**

- Each span has an `id`. The trace is identified by `root_span_id` [48].
- Span types: eval, task, llm, function, tool, score, review, automation, preprocessor, facet, classifier [48].
- `metrics.estimated_cost` rolls up into parents [48].

**Linear agent activities**

- An append-only activity log per session: thought, action{action, parameter, result}, elicitation, response, error, prompt [59][60].
- An optional `ephemeral` flag [59].
- The session plan is a replaced-whole array [59].
- Session state is derived from the last activity [59].
- The docs recommend reconstructing history from activities, not editable comments [60].

**Durable workflow engines**

- Temporal persists a full event history, downloadable as JSON [50].
- Inngest records per-attempt spans and memoized step outputs, which enables rerun-from-step [53][54].

**Claude Code**

- JSONL transcripts are stored per session and per subagent, with 30-day cleanup by default [3].
- Optional OTel metrics, logs and events, and beta traces, with content redacted by default [6].

**Implication for Psyche** *(synthesis)*

- Persist an append-only `RunEvent` log, closest to the Linear and Temporal models.
- Derive the span tree from that log, with OTel GenAI-compatible names (`invoke_agent`, `execute_tool`, `chat`) and a per-attempt `attempt` field.
- Store content behind an opt-in flag with capture-time masking.
- Export as OTLP JSON.
- Set a local retention default (for example 30 days, like Claude Code [3]) with per-run pinning.

---

## Sources

1. https://code.claude.com/docs/en/interactive-mode
2. https://code.claude.com/docs/en/desktop
3. https://code.claude.com/docs/en/sub-agents
4. https://code.claude.com/docs/en/agent-view
5. https://code.claude.com/docs/en/settings-reference
6. https://code.claude.com/docs/en/monitoring-usage
7. https://code.claude.com/docs/en/agent-sdk/todo-tracking
8. https://cursor.com/docs/agent/overview
9. https://cursor.com/docs/cloud-agent
10. https://cursor.com/changelog/1-2
11. https://cursor.com/de/changelog/1-4
12. https://docs.devin.ai/work-with-devin/devin-session-tools
13. https://docs.devin.ai/product-guides/session-insights
14. https://manus.im/docs/features/cloud-browser
15. https://manus.im/docs/features/wide-research
16. https://manus.im/docs/features/collab
17. https://manus.im/docs/introduction/welcome
18. https://www.technologyreview.com/2025/03/11/1113133/manus-ai-review
19. https://openai.github.io/openai-agents-python/tracing/
20. https://developers.openai.com/api/docs/guides/agents-api/tracing
21. https://openai.com/blog/introducing-operator (mirror read: https://readwise.io/reader/shared/01jjb1jaekf0gtmk3egshfe6dm)
22. https://cdn.openai.com/pdf/4375e605-f9a6-438d-bcc8-190599c183a6/o3_cua_system_card.pdf
23. https://www.datacamp.com/tutorial/chatgpt-agent
24. https://www.journalofaccountancy.com/issues/2025/nov/creating-an-ai-agent-in-chatgpt/
25. https://every.to/vibe-check/vibe-check-openai-enters-the-browser-wars-with-chatgpt-agent
26. https://help.openai.com/en/articles/12628199-using-atlas-agent-mode
27. https://www.computerworld.com/article/4138723/perplexitys-new-computer-agent-will-run-other-agents-for-you.html
28. https://eesel.ai/blog/perplexity-computer
29. https://www.techradar.com/ai-platforms-assistants/gemini/perplexity-upgrades-comet-to-multitask-across-your-tabs
30. https://www.datacamp.com/tutorial/perplexity-labs
31. https://www.shapeof.ai/patterns/stream-of-thought
32. https://docs.replit.com/core-concepts/agent/checkpoints-and-rollbacks
33. https://docs.replit.com/getting-started/quickstarts/ask-ai
34. https://help.zapier.com/hc/en-us/articles/33336184962573
35. https://help.zapier.com/hc/en-us/articles/24593764847757
36. https://langfuse.com/changelog/2024-06-12-timeline-view
37. https://langfuse.com/changelog/2025-03-19-new-trace-view
38. https://langfuse.com/changelog/2025-11-05-langfuse-for-agents
39. https://langfuse.com/docs/observability/features/agent-graphs
40. https://langfuse.com/docs/observability/features/observation-types
41. https://langfuse.com/docs/observability/data-model
42. https://langfuse.com/docs/observability/features/masking
43. https://langfuse.com/docs/administration/data-retention
44. https://docs.langchain.com/langsmith/cost-tracking
45. https://docs.langchain.com/langsmith/threads
46. https://docs.langchain.com/langsmith/mask-inputs-outputs
47. https://docs.smith.langchain.com/concepts/usage_and_billing/data_retention_billing
48. https://www.braintrust.dev/docs/observe/examine-traces
49. https://www.braintrust.dev/docs/reference/cli/view
50. https://docs.temporal.io/web-ui
51. https://temporal.io/changelog/updated-event-history-timeline-view-is-now-available
52. https://temporal.io/blog/lets-visualize-a-workflow
53. https://www.inngest.com/docs/platform/monitor/traces
54. https://www.inngest.com/docs/platform/manage/rerun-function-runs
55. https://help.apple.com/instruments/mac/current/en.lproj/devc12c5417.html
56. https://help.apple.com/instruments/mac/8.3/en.lproj/devd53abb62.html
57. https://developer.apple.com/documentation/os/recording-performance-data
58. https://linear.app/changelog/2025-04-03-collapsed-issue-history
59. https://linear.app/developers/agent-interaction
60. https://linear.app/developers/agent-best-practices
61. https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs
62. https://docs.github.com/en/enterprise-server@3.6/actions/using-workflows/workflow-commands-for-github-actions
63. https://www.anthropic.com/engineering/building-effective-agents
64. https://www.microsoft.com/en-us/research/blog/magentic-ui-an-experimental-human-centered-web-agent
65. https://arxiv.org/html/2507.22358v1
66. https://www.nngroup.com/articles/response-times-3-important-limits/
67. https://www.chrisharrison.net/index.php/Research/ProgressBars
68. https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
69. https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
