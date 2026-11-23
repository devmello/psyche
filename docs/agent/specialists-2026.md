# Background specialists (2026)

**Owner:** S02 (agent runtime). **Status:** spec, 2026-10-25. **Issues:** epic #688; R #683, P0 #682, K #684, U #685. **Asked by:** the owner ("Implement background specialists").

**Related specs:**
- [docs/design/run-trace-2026.md](../design/run-trace-2026.md) (mission control, being written in parallel by the design lead). Specialists appear there as branches of a run; §6.3 lists what this spec needs from it.
- [docs/connectors/apple-apps-2026.md](../connectors/apple-apps-2026.md) §8, for how the briefs in §8 are written.

**Research behind this plan, with sources:**
- [research/frameworks.md](research/frameworks.md): Claude Code subagents and the Agent SDK, the OpenAI Agents SDK, Anthropic's multi-agent research system, CrewAI, AutoGen / AG2 and LangGraph. Covers how each scopes context, tools, models and budgets, hands results back and fails.
- [research/products.md](research/products.md): Devin, Manus, Perplexity, Replit Agent and Zapier Agents, plus ChatGPT agent, Claude's background tasks and Jules. Covers how each starts, shows, interrupts, prices and finishes background work, and what users say about it.

**The short version.** The owner asks for something that takes a while: "find me three apartments under $2,500 near the office", "clean up my Downloads", "draft the grant report". Today the agent has two answers, and both run inside the turn:
- `subagent.spawn` blocks the turn and has no approval authority.
- `task.start` runs another turn of the same generalist agent.

A **specialist** is a third answer:
- **What it is:** a named role (researcher, shopper, coder, organizer, writer, planner) with its own prompt, tools, model, budget and deadline.
- **How it runs:** in the background as a durable Task, in its own thread.
- **How it shows up:** it reports progress as steps in the run trace, and asks the owner only through the approval cards and question cards that already exist.
- **How it finishes:** it delivers a result card to the Inbox, with its artifacts and a receipt of what it did.
- **Owner control:** several can run at once, and the owner can watch, steer, pause or cancel each one.

Most of the machinery exists: the task engine, the worker pool, approvals, the step log, the evaluator (C7) and the harness seam (C10). The work is:
- a spawn primitive that binds a role to a Task;
- role definitions as bundled skills;
- the parent/child run link in the protocol;
- the result card.

## 1. Where we are (main, 2026-10-25)

| Piece | What it does today | Gap for specialists |
| --- | --- | --- |
| **Subagents (C6)**, `packages/agent-core/src/loop.ts` `#spawn` | `subagent.spawn {context: fork \| fresh, title, brief}` runs a child run *inside the parent's turn*. Limits: 20 steps, 4 at once, no nesting. The child has no `ask_user`, messaging or approval authority. Taint flows both ways; the child's tokens count toward the parent. | Blocks the parent turn. Dies with the parent turn. Same model and tools as the parent. Can't ask the owner anything, so a shopper that needs a login stops. |
| **Tasks (D1–D3)**, `packages/tasks` | Durable Tasks with leases. A worker pool runs 2 turns at once. A per-turn `TaskBudget {maxSteps, maxTokens, maxWallMs}`. Checkpoints, with `uncertain` reconciliation. Approvals park the task in `awaiting_approval`, input requests park it in `awaiting_input`. `task_done` / `task_failed` notifications. Pause, resume, cancel, retry. | No role, model, tool allowlist or deadline. The budget is per turn, not per job. Tasks run in the creating thread, and the Gateway passes no `permissionModeFor`, so every task runs `balanced`. No parent run. |
| **`task.start`**, agent-core built-in | Creates a Task in the current thread that inherits taint. | Starts a generalist. Nothing comes back to the parent run. |
| **Evaluator (C7)**, `src/evaluator.ts` | A task run with receipts is checked against the goal before it can end done. | Exactly what a specialist's result needs. Keep it. |
| **Harness seam (C10)** + the Claude Code harness (commit `c3c487f9`); **coding helper (V10)** `src/coding/` | `harness.delegate` runs Claude Code with every action gated as `harness__<id>__<tool>`. The coding tools work in granted folders and the sandbox. | The coder specialist is these tools plus a role. No new runtime. |
| **Step log** (#630), `packages/ui/src/chat/RunStepLog.tsx`; **`chat.reasoning`** (#633) | Steps of the running message: tool, text, approval, question, thinking. | No "specialist" step that links to a child run. |
| **Inbox**, `Notification` (`task_done`, `task_failed`, …) | Rows with a title, a body and a deep link (`route`). | No result card: no artifacts, receipts, cost or "what it did". |
| **Run** schema | `{id, threadId, status, modelRef, attempt, usage, …}` | No `parentRunId`, role, budget or deadline. |
| **Skills**, `skills/*/SKILL.md` | Frontmatter `requires.tools`, `metadata.psyche`. `research-brief` already suggests parallel `fresh` subagents. | No role definition: prompt, allowlist, model class, default budget. |

## 2. What users want (evidence summary)

### 2.1 What the frameworks converge on ([research/frameworks.md](research/frameworks.md))

| Finding | Evidence | Where it lands here |
| --- | --- | --- |
| **Start fresh from a structured brief.** Children see their prompt and the delegation message, not the parent conversation. Vague briefs cause duplicated work. | Claude Code sub-agents; `Agent.as_tool` keeps no parent history; Anthropic's research system (objective, output format, tools and sources, boundaries) | §3.5, §4.2; the brief fields in §4.8 |
| **Hand back a short result plus references**, not the transcript | Claude Agent SDK returns only the final message; Anthropic subagents write to storage and pass references | §4.2 `specialist.report` |
| **Budgets live in the runtime.** Cap turns, tokens, dollars and wall time together. | `maxBudgetUsd` refuses new spawns and stops running subagents; OpenAI only tracks usage; AutoGen composes limits | §3.3, §4.6 |
| **"Partial" is a result state** | Claude Code keeps output at `maxTurns` and on API errors; `/deep-research` marks claims "unverified" | §3.9, §4.6 |
| **Approvals survive long waits** (durable parking) and are labelled with the child's name. Agent text is never consent. | OpenAI serializable `RunState`; LangGraph `interrupt()` checkpoints; SDK `defer`; AutoGen's blocking proxy can't be saved; Claude Code labels child prompts and marks inter-agent messages as not from the user | §3.4, §4.4 (the task engine already parks durably) |
| **Specialist output is untrusted input** | Claude Code neutralizes instruction-shaped text in subagent reports (v2.1.210) | §4.2 (report sanitizing), §9 |
| **One checkpoint mechanism** for pause, resume and crash | LangGraph per-super-step checkpoints; Claude workflows replay finished agents | §4.6 (D2 checkpoints) |
| **Low caps on concurrency and depth**, with a queue | Claude Code 20 concurrent / 3 levels; teams start at 3–5 | §3.8, §4.5 (3 slots, no nesting) |
| **Effort scaling in the lead prompt, backed by caps** | Anthropic: early versions spawned 50 subagents for simple queries; 1 agent for a fact, 2–4 for a comparison, 10+ for complex research | §4.8, §5.2 |
| **Show cost before and during** | Multi-agent runs used about 15× a chat's tokens; Claude Code warns above 25 agents or 1.5M projected tokens | §4.6, §6.1, §6.2 |
| **Graceful stop vs hard cancel** | AutoGen `ExternalTermination` vs cancellation token; OpenAI `cancel(mode="after_turn")` | §4.7 (pause vs cancel) |

### 2.2 What shipped products teach ([research/products.md](research/products.md))

| Finding | Evidence | Where it lands here |
| --- | --- | --- |
| **A budget hit pauses and asks; it doesn't kill.** The budget clock stops while the job waits on the user. | Zapier caps each run at 10 or 40 activities, then "pauses and asks for your input"; Perplexity pauses tasks at the account cap and offers "raise limit"; Devin sessions sleep at no charge until a message wakes them | §4.6 (pause with "Give it more / Finish with what it has"), §4.4 |
| **Show cost live, per job, and an end-of-run total** | Replit's "$1K in a week" complaints led to progressive spend updates and a charge summary; Perplexity shows a live credit counter | §6.1 budget ring, §6.2 usage line |
| **One plan approval up front for long jobs**, not dozens mid-run | Jules, Devin, Replit Plan mode and Perplexity Computer (with a credit estimate) all show a plan before costly work | §4.1 `planFirst` |
| **Remember approvals for the rest of the job** | Comet asks once per page and remembers for the task; users approve about 93% of prompts (secondary source) | §3.7, §4.4 (`task` scope) |
| **Questions carry a default** and record when one was used | Devin's one-tap suggested answers and "skipped" markers | §4.4 questions |
| **A small, fixed status vocabulary** | Zapier: Needs action, In progress, Failed, Cancelled, Completed | §6.2 statuses |
| **A child job inherits a summary, not the transcript** | Devin child sessions start from a summary; Manus sub-agents get fresh contexts (secondary source) | §3.5 |
| **Separate useful spend from spend lost to errors** | Manus and Perplexity refund credits on platform failures | §4.6, §6.2 |
| **Cap by owner attention, not compute** | "Two parallel sessions already feel like my limit" (HN); Jules allows 3, 15 or 60 concurrent | §3.8 (3 slots) |
| **Results are artifacts plus a short summary**, outcome-only notifications | Jules ends with files changed, runtime and "Create branch"; Dispatch sends the outcome, not every step | §4.2, §6.2 |
| **Overlong reports and silent failures are the top complaints** | Deep Research reports called "quite verbose"; Devin "would spend days pursuing impossible solutions" (3 of 20 tasks done in Answer.AI's test) | §4.2 caps; §4.6 two failures end the job; the stall rule (§9) |

## 3. Decisions

1. **A specialist is a Task, not a long subagent.** The task engine already survives restarts, holds leases, parks on approvals and questions, and notifies. A specialist is a Task with:
   - `createdFrom: "subagent"`;
   - a `specialist` block (role, brief, budget, deadline, parent run);
   - its own thread of kind `subagent`, whose parent is the requesting thread.

   `subagent.spawn` stays for short, synchronous fan-out inside a turn (research sub-questions). Specialists are for jobs that outlive the turn.
2. **Roles are bundled skills with a `specialist` section.** One `SKILL.md` per role holds the prompt, the tool allowlist, the model class, the default budget, the approvals to expect and the result template. They are editable and overridable like any skill. An approved skill never widens tool policy (architecture §13); the allowlist can only narrow.
3. **Budgets are per job and enforced by the runtime, never by the model.** Each spawn carries a token budget, a cost ceiling, a wall-clock time budget and a deadline:
   - **Token budget:** counted across every turn of the job.
   - **Cost ceiling:** priced through the usage ledger.
   - **Time budget:** wall-clock limit for the job.
   - **Deadline:** an absolute time.

   The engine checks them between steps. On a budget breach the job pauses and asks the owner to give it more or finish with what it has; at the deadline, or in an unattended run, it finishes with a partial result (§4.6). Defaults come from the role; the owner caps them per role in Settings.
4. **The owner is asked only through existing cards.** A specialist does have approval authority, unlike C6 subagents: it raises the same `ApprovalRequest`s, with the same tiers, `deviceOnly` rules and expiry. Each card adds "for {task}, started by {agent} from {thread}". Questions use the task path (`TaskEngine.requestInput`). Nothing new can ask the owner.
5. **Isolation by default.**
   - **Context:** the child starts *fresh*: the role prompt plus the brief the parent wrote plus the files the parent passed. It does not get the parent's transcript.
   - **Results:** a structured result, a short report, artifacts and receipts come back. The transcript stays in the child thread, viewable.
   - **Fork:** stays a subagent-only option. A transcript copy leaks too much into a long job, and makes its context, cost and taint harder to reason about.
6. **Taint and scope never widen.** The child starts with the parent run's taint and taint sources, as Tasks already do. Its permission mode is the parent thread's, capped by the role (a researcher never gets `auto` writes). A tainted child's result is `untrusted` and taints the parent run that reads it.
7. **Approval fatigue is a design constraint.** The defaults are:
   - read-only tools first;
   - one card per new site per job, using the `task` scope;
   - a pre-flight line at spawn that names the approvals the job will likely need, so the owner can answer the first card with **Allow for this task**, which covers the rest of the job's calls with the same `grantKey`.

   The broker has no batched cards and no dry-run decide today. The pre-flight is therefore informational: it comes from the role's declared `approvals` and the parent's mode, and grants nothing by itself.
8. **Concurrency is bounded and visible.**
   - At most **3** specialists run at once, in a dedicated pool slot set so they never starve chat tasks.
   - Further spawns queue, in order, with their place shown.
   - A job waiting on the owner frees its slot.
9. **One delivery.** A specialist ends with exactly one result card in the Inbox:
   - **done** (with the evaluator verdict);
   - **partial** (budget, deadline or a failed step, with what it got);
   - **failed**;
   - **cancelled**.

   The parent thread gets one line linking to it. No per-step notifications, only the cards that need the owner.

## 4. The runtime

### 4.1 The spawn primitive

The new built-in replaces neither `subagent.spawn` nor `task.start`; both stay.

```ts
specialist.spawn {
  role: "researcher" | "shopper" | "coder" | "organizer" | "writer" | "planner" | string, // a skill with a `specialist` section
  title: string,              // ≤ 80 chars, the task title the owner sees
  brief: string,              // ≤ 8,000 chars: goal, scope, constraints, what done looks like
  inputs?: { libraryItemIds?: string[]; folders?: string[]; urls?: string[] }, // what the parent passes
  budget?: { tokens?: number; costUsd?: number; minutes?: number },  // ≤ the role's caps; stored as Run.budget.limit (wallMs)
  deadline?: string,          // ISO-8601; must be after now
  deliver?: "inbox" | "thread", // default inbox (a result card); thread posts the result as a message too
  planFirst?: boolean,        // default from the role (§4.1 "Plan first")
}
→ { taskId, runId, threadId, status: "queued" | "running", position?: number, preflight: ApprovalHint[] }
```

**Plan first.** Roles with `planFirst: true` (the coder and the shopper by default) start in `plan` mode. Their first turn researches read-only and ends with `exit_plan_mode`, whose `plan_exit` card shows the plan with the budget and deadline. On approval the job continues in its normal mode; on denial it ends `cancelled` with the plan as its report. This is the "one approval up front" pattern from §2.2. A spawn can set `planFirst: false` only when the owner asked for no plan.

`specialist.spawn` has side effect `none`: starting work is free, and every action the specialist then takes goes through the broker. It returns at once. The parent is not blocked, and its step log gets a `subagent` step (§6.1) that links to the child run.

**What the runtime does on spawn** (agent-core `src/specialists.ts`, new):

1. **Resolve the role.** It is an enabled skill with a `specialist` section (§5), and the role is turned on in Settings. Otherwise the call is blocked with `specialist {role} is off`.
2. **Clamp the request.** The budget becomes `min(requested, role default when absent, Settings cap)`. The deadline must be at most `now + role.maxHours`.
3. **Create the Task** with `createdFrom: "subagent"`, `title`, `goal = brief`, `mode: attended`, and `taint` / `taintSources` copied from the parent run.
4. **Create the thread** with kind `subagent`, `parentThreadId` = the parent's thread, and the title. For an incognito parent the thread is incognito too (§4.9).
5. **Store the specialist record** on the task (§7.1): role, parent ids, model, allowlist, budget, deadline, inputs and the permission mode.
6. **Queue it in the specialist pool** (§4.5) and return.

### 4.2 Isolation: what goes in, what comes out

**In** (the child's first turn), in this order:
- the role prompt (the skill body), the role's persona overlay (none by default: specialists speak as the agent, see §6.5), and the base safety rules;
- the parent's brief, verbatim;
- **inputs** as references, not contents: Library items, granted folders and URLs. The child reads them with tools, so reads are gated and tainted like any other.
- `USER.md` facts the role is allowed (§5: `memory: user | none`). `MEMORY.md` is never included, matching group threads (architecture §4.8).

**Not in**:
- the parent's transcript, other threads, the parent's checklist;
- the parent's open approvals or grants. Grants are per Task, and `task` grants do not cross tasks.

**Out** (exactly one result, written by the child's final `specialist.report` call):

```ts
specialist.report {
  outcome: "done" | "partial" | "failed",
  summary: string,              // ≤ 600 chars, Psyche shows it on the card
  findings?: { title: string; detail: string; sources?: string[] }[], // ≤ 12
  artifacts?: string[],         // artifact / Library item ids the child created
  next?: { label: string; message: string }[], // ≤ 2 suggested follow-ups (become card buttons)
  gaps?: string[],              // for partial: what is missing and why
}
```

- The runtime attaches what it knows: receipts, usage and cost, wall time, step count, the evaluator verdict and the taint flag.
- A child that ends without calling `specialist.report` gets one built from its last message, marked `partial`.
- The parent run, if still active, gets the result as an update of that `subagent` step. Otherwise the parent thread gets one system line with the card link.
- The parent model reads the result only when it asks for it, through **`specialist.status {taskId?}`**. This read-only, side-effect-`none` tool lists the thread's jobs with status, `used` / budget, and, for finished jobs, the report. Its output is `untrusted` when the job was tainted. Results are not pushed into a live context unasked, which keeps a long job's output out of an unrelated turn.
- A tainted result is `untrusted`.
- **Report sanitizing.** Before the parent model or a card reads a report, its text fields go through the same sanitizer approval cards use (`packages/permissions/src/cards.ts` `sanitizeBlock`). That neutralizes fake control tags, turn markers and card-like lines, as Claude Code does since v2.1.210. A report never counts as the owner's words or consent.

### 4.3 Model, tools and permission scope

- **Model:** by role class, from Settings → Specialists, falling back to the router roles:
  - `utility` for organizer;
  - `primary` for researcher, writer and planner;
  - the installed coding harness (`harness.delegate`) for coder, else `primary`;
  - `primary` with vision for shopper.

  A user-pinned `/model` on the parent thread does not carry over. Only models on the auto-mode allowlist may run a specialist whose role allows writes without asking (security §7.3).
- **Tools:** the role's allowlist, intersected with the tools active for the parent's permission mode and the owner's per-tool toggles. Never more.
  - Always withheld: `specialist.spawn` (no nesting in v1), `subagent.spawn` (except for researcher, which may fan out up to 4 `fresh` subagents inside its own budget), `schedule`, `wrap_up`, and `exit_plan_mode` (except in a `planFirst` job's plan turn).
  - `ask_user` is allowed: it goes through `TaskEngine.requestInput`.
- **Permission mode:** `min(parent thread mode, role.maxMode)`, ordered plan < manual < balanced < auto.
  - `specialist.spawn` is withheld in plan mode, as `task.start` is (`PLAN_WITHHELD`): plan mode allows only side-effect-`none` tools, which leaves a specialist nothing to work with. A plan-mode thread proposes the job in its plan instead, and spawns after the plan is approved.
  - The Gateway finally wires `permissionModeFor` for specialist tasks (it passes none today, so every task runs `balanced`).

### 4.4 Approvals routed to the owner

- Every `ask` from a specialist creates the normal `ApprovalRequest`.
- `requestedBy` carries `taskId`, the child `runId`, the `threadId`, and the new optional `parentRunId` and `specialist` role (§7.1).
- The card adds one line in Psyche's voice: "For **{task}** · {role} started by {agent} in {thread}". Tiers, `deviceOnly`, expiry and arm delay are unchanged.
- While it waits, the task parks `awaiting_approval` and frees its pool slot. The answer re-queues it.
- **Pre-flight.** On spawn, the runtime builds `preflight: ApprovalHint[]` from the role skill's `metadata.psyche.approvals` (skills already declare these, e.g. `research-brief` → `new_origin`) and the effective mode, e.g. "Will ask before opening new sites (about 5)". It shows them on the parent's step and in the spawn line. It grants nothing. The first real card for each `grantKey` recommends **Allow for this task** (`task` scope) where the side-effect class allows it; `destructive` and `financial` still ask per call (security §3.4). When the brief names URLs, the pre-flight is exact for them: `PermissionBroker.preview` dry-runs one navigation per URL, the asks are counted ("about 3"), and a declared kind no call was previewed for stays listed. Without URLs it is the declared list (#686).
- **Questions.** A specialist's `ask_user` must mark one option `(Recommended)`. The question card names the task and the role. A role may set `proceedOnDefaultAfter` (off by default; at most 24 h): when the wait passes, the job continues with the recommended option, and the card and the report both say "Used the default: {label}", as Devin marks skipped questions. Approvals never proceed on a default.
- **Taint escalation is unchanged.** A tainted specialist writing to a new target asks, even under a `task` grant the owner gave on an earlier card (security §3.6). "New" is computed against the brief's targets and `inputs`, never against what the child read, so an injected page can't make its own target look requested.

### 4.5 Concurrency and queueing

- A **specialist pool** with 3 slots (`specialists.maxConcurrent`, 1–6), separate from the chat task pool's 2. The same `TaskWorkerPool` code runs with `owner: "specialist"` and a claim filter for `createdFrom: "subagent"`.
- Spawns beyond the slots queue FIFO. The spawn result returns `position`, and the step log shows "Queued · 2nd".
- A job parked on the owner (approval or question) frees its slot. Re-queued jobs go to the front.
- Per-thread fairness: one thread can hold at most 2 running slots, so a single conversation can't take all three.

### 4.6 Budgets, deadlines, retries and partial results

- **Accounting:** each specialist run records usage against its task. `budget.used = {steps, tokens, wallMs, costUsd}` (the `Run.budget` shape, §7.1) lives on the task's specialist record, summed over turns, and is updated after every model call; the child run carries the same numbers.
- **Checks:** between steps, the runtime checks `used` against the budget and the deadline.
  - At 80% it emits a `budget` step ("80% of the token budget used") once.
  - **At 100% of a budget**, it stops after the in-flight tool call and **pauses**, as Zapier and Perplexity do. The job parks `awaiting_input` with a question card in Psyche's voice: "{role} used its {budget} budget on {task}". The options are **Give it more** (+50%, capped by Settings), **Finish with what it has** (Recommended) and **Stop it**. The budget clock stops while it waits.
  - **At the deadline**, or on **Finish with what it has**, it runs one short, tool-free **wrap-up turn** (≤ 2k output tokens, utility model) that writes `specialist.report {outcome: "partial", gaps}`, then delivers. In unattended runs (§4.10) it never pauses: a budget hit goes straight to the wrap-up turn.
  - Partial is a first-class outcome, not an error.
  - Usage separates work from waste. `used` records tokens and cost spent on calls that were retried after provider or transport errors (`used.retried`), and the card shows them apart ("incl. $0.12 retried after errors").
- **Cost with no price:** for unpriced runs (subscription CLI providers report `unpriced`), the cost ceiling is skipped, and the token and time budgets still apply.
- **Retries:**
  - Model and transport errors retry inside the router: fallbacks and cooldowns.
  - A crashed worker's lease expires and the job resumes from its last checkpoint. `replaySafe: false` steps that were running become `uncertain` and are reconciled, never replayed (as D2 does today).
  - A job that fails twice in a row on the same step ends `failed`, with the partial report.
  - The owner can **Retry** from the card, which starts `attempt + 1` with the report's `gaps` appended to the brief.
- **Evaluator (C7):** it runs on `done` reports that have receipts. `reopen` continues once within budget; `escalate` asks the owner (attended) and turns the card "Needs you".

### 4.7 Steering, pausing, cancelling

| Owner action | Where | Mechanism |
| --- | --- | --- |
| Watch | Mission control, the card, the parent step | Open the child thread (view-only transcript plus its step log) |
| Steer | A composer on the child's view ("Tell the shopper…") | `tasks.steer {taskId, text}`: `AgentLoop.steer` on the running run, or queued as the next turn's first message if parked. Text is owner provenance. |
| Pause | Row menu, card | `tasks.pause`: stops after the in-flight call, frees the slot, keeps the budget clock stopped |
| Resume | Row menu | `tasks.resume`: re-queues at the front |
| Cancel | Row menu, card, ⌘. on the child view | `tasks.cancel`: revokes run authority at once (architecture §4.5). In-flight provider requests are reconciled by receipt. The card says what was done before the stop. |
| Change budget | Row menu → "Give it more time" | `tasks.update {budget}`, capped by Settings. Only the owner can raise it; the parent agent cannot. |

Steering from the *parent agent* is not offered in v1: the parent can spawn, read results and cancel only its own children. That keeps the owner in charge of a running job's direction.

### 4.8 When the main agent delegates (and when not)

The decision is in the main prompt and the role skills' `description` lines, not in code. Rules for the base prompt section "Specialists":
- **Delegate** when the job:
  - needs many tool calls or more than a few minutes;
  - can run without the owner after a clear brief;
  - fits one role.

  Examples: multi-source research, comparing products, a folder cleanup, a first draft from sources, a coding change in a granted repo.
- **Don't delegate:**
  - a question you can answer in a few steps;
  - anything the owner is actively doing with you;
  - anything that needs back-and-forth to define;
  - anything whose main risk is a send, payment or delete. Do that in the thread, where the owner sees the card in context.
- **Before spawning:**
  - write the brief as a complete instruction (goal, scope, constraints, what done looks like, how to report);
  - say the budget and deadline in one line of chat;
  - mention the likely approvals.

  At most 3 specialists per owner request, unless the owner asks for more.
- **After spawning:** tell the owner in one sentence what started and where to watch it. Don't wait on it, and don't poll it.

The evaluation (§8, fixtures) checks delegation choices on a set of 30 scripted requests with an expected "delegate to X / don't" label.

### 4.9 Privacy: incognito, memory, channels

- **Incognito parent:** the specialist's thread is incognito.
  - No memory flush, no index, the same 24 h expiry.
  - Its result card is visible only from that thread, and it expires with it.
  - Its artifacts live in a temporary Library collection that expires too, unless the owner saves them.
- **Memory:** specialists never write `USER.md`, `MEMORY.md` or the persona files (no `memory` writes outside today's daily note, tagged `agent` or `untrusted`). Their findings reach long-term memory only via dreaming, from the daily note, under the usual promotion rules.
- **Non-owner requesters:** a channel turn from someone other than the owner (security §9) cannot spawn specialists in v1.
- **Unattended runs** (automations, heartbeat) may spawn specialists only through the automation's own `specialist` field (§4.10), never from free model choice.

### 4.10 Scheduled automations as specialists

- `Automation` gains an optional `specialist {role, budget, deliver}`. A run of that automation is a specialist job: the automation prompt is the brief, and `mode` is `unattended`.
- Approvals are deferred into the queue with a notification. Nothing is attempted (C8), exactly as today. `NO_REPLY` produces no card.
- The result card says "From your automation {name}".
- Examples: the weekly price check (shopper), the Monday inbox triage (organizer), the morning brief (researcher).

## 5. Specialist definitions (bundled skills)

### 5.1 The `specialist` section

Each role is a skill folder `skills/specialist-<role>/` with:
- `SKILL.md` (frontmatter plus the role prompt as the body);
- `acceptance.md`;
- `examples/` (two scripted fixtures).

New frontmatter, under `metadata.psyche.specialist`:

```yaml
metadata:
  psyche:
    specialist:
      role: researcher            # id; the tool's `role` value
      label: Researcher           # Settings and cards
      model: primary              # utility | primary | harness | vision
      maxMode: balanced           # plan | manual | balanced | auto (cap)
      tools: [search, fetch, "browser.*", memory_search, "artifact.create", "pdf.*", subagent.spawn, update_plan]
      deny: [browser.fill_credential, browser.upload]   # exact tool names removed after expansion
      memory: user                # user | none (which persona facts it sees)
      budget: { tokens: 400000, costUsd: 2.00, minutes: 30 }   # defaults
      caps:   { tokens: 2000000, costUsd: 10.00, minutes: 240, maxHours: 24 }
      result: findings            # findings | draft | changes | plan | items (shapes the card)
      planFirst: false            # true for coder and shopper
    approvals: [new_origin]       # existing skill field; feeds the spawn pre-flight (§4.4)
```

`tools` uses the capability vocabulary skills already use. Capability families in `TOOL_CAPABILITIES` (`packages/skills/src/gating.ts`: `search` → `web_search`, `fetch` → `web_fetch`, `artifact.create` → `write_file`, `email.*` → `gmail_*` / `mail_*`, …) expand to their tools. Everything else is an exact tool name or a `prefix.*` pattern. `deny` removes exact names after expansion, so "mail, but never send" is `email.*` plus `deny: [mail_send, gmail_send]`.

The loader (S16, `packages/skills`) validates the section:
- every tool pattern must name tools that exist;
- `maxMode` is capped at `balanced` for any role whose tools include a `recipient` or `financial` tool.

An owner-installed skill can define a new role. It runs with the same caps, and it is off until the owner turns it on in Settings.

### 5.2 The six bundled roles

| Role | Job | Tools (`tools` / `deny`) | Model | Max mode | Default budget | Result |
| --- | --- | --- | --- | --- | --- | --- |
| **Researcher** | Multi-source research → cited brief | `search`, `fetch`, `browser.*`, `memory_search`, `pdf.*`, `sheet.*`, `artifact.create`, `subagent.spawn` (≤ 4 fresh), `update_plan` / deny `browser.fill_credential`, `browser.upload` | primary | balanced | 400k tok · $2 · 30 min | findings + a brief artifact |
| **Shopper** | Find, compare and hold items; never buys | `search`, `fetch`, `browser.*`, `shop_search`, `artifact.create`, `update_plan` / deny `browser.upload` (credential fills stay, card-gated) | primary + vision | balanced | 300k · $2 · 45 min | items: a comparison table, links, holds; purchases left to the owner on the card |
| **Coder** | A change in a granted repo, tested | `code.*`, `read_file`, `edit_file`, `write_file`, `list_dir`, `search_files`, `exec`, `browser.dev_preview`, `harness.delegate` (when installed) | harness, else primary | balanced | 1M · $5 · 60 min | changes: a diff, test output, a branch or patch file |
| **Organizer** | Files, mail, reminders, calendar and notes tidy-ups | `files.*`, `list_dir`, `search_files`, `email.*`, `reminders.*`, `calendar.*`, `notes.*`, `update_plan` / deny `mail_send`, `gmail_send` | utility | balanced | 150k · $0.50 · 20 min | changes: a list of moves with undo |
| **Writer** | A draft from sources and the owner's voice | `memory_search`, `read_file`, `fetch`, `pdf.*`, `artifact.create`, `mail_draft`, `gmail_create_draft` | primary | balanced | 200k · $1 · 20 min | draft: an artifact, plus an optional mail draft |
| **Planner** | A plan or schedule; nothing changes | `calendar_list_events`, `calendar_list_calendars`, `reminders_list`, `search`, `fetch`, `artifact.create` (read-only allowlist plus the plan artifact) | primary | balanced | 150k · $1 · 15 min | plan: a Plan artifact the owner can start, which hands steps to other roles only on approval |

Tool names are as on main, 2026-10-25. Apple wave-1 tools (docs/connectors/apple-apps-2026.md §4: `calendar_find_free_time`, `files_*`, `mail_move`, …) join the families automatically when they land; the planner adds `calendar_find_free_time` by name then.

- Each role prompt follows the lessons in [research/frameworks.md](research/frameworks.md):
  - objective, output format, tools and boundaries stated;
  - effort guidance ("simple lookups: 3–10 tool calls; comparisons: 10–20");
  - stop and report criteria;
  - "report what you could not do".

  The writer and organizer prompts also carry the owner's voice rules from `docs/copy/voice.md` for anything the owner will read.
- Existing skills `research-brief`, `shopping-compare` and `inbox-triage` keep working in-thread and gain one line pointing at the matching specialist for long jobs.

## 6. Surfaces

### 6.1 The parent's step log

The trace spec's `RunStep` already has the kind for this: `kind: "subagent"` with `childRunId` and `taskId`, where `progress` is the last child step label and `usage` is the child's budget use. The role lives on the child run (`Run.specialist.role`); the step's label is "Shopper · Apartments near the office".

- It shows a status glyph, the label, the last child step, and a budget ring once usage passes 50%.
- Clicking it opens the child view (mission control's branch).
- It stays in the log after the parent run ends.

### 6.2 The result card (Inbox and Feed)

- **Statuses** (one fixed vocabulary everywhere): **Queued**, **Working**, **Needs you**, **Done**, **Partial**, **Failed**, **Cancelled**. "Needs you" covers approvals, questions and budget pauses.
- **Inbox row:** a two-line row with the role glyph and the title.
  - **Line 2:** `Done · 3 findings · $0.84 · 22 min`, or `Partial · token budget`, or `Needs you · 1 approval`.
- **Opened card:**
  1. **Summary:** the report's `summary`.
  2. **Findings or items:** collapsed after 3.
  3. **Artifacts:** chips that open in their pane.
  4. **What it did:** the receipts, as facts per `docs/copy/voice.md` rule 5.
  5. **Usage:** tokens, cost, time and steps, against the budget.
  6. **Taint note:** shown when tainted ("Read content from 6 sites. Treat its claims as unverified.").
  7. **Actions:** up to 2 from `next`, plus **Open thread** and **Retry** (for partial and failed).
- **Feed:** only when the owner turns "Show specialist results in Feed" on. Off by default: the Inbox is the delivery.

**Copy** (Psyche's voice, for `docs/copy/system-messages.md`):

| Moment | Text |
| --- | --- |
| Spawned (parent chat line, agent voice) | "I've asked the {role} to {title}. It'll take up to {minutes} min; I'll put the result in your Inbox." |
| Queued | "Queued · {n}th · starts when a slot frees" |
| Needs you | "{role} needs your approval for {task}" (the approval card is the existing one) |
| Budget pause (question card) | "{role} used its {budget} budget on {task}." Options: "Give it more", "Finish with what it has", "Stop it" |
| Partial | "Stopped at its {budget} budget. It got {n} of {m} done; see what's missing." |
| Failed | "{role} couldn't finish {task}: {reason}. Nothing was sent or bought." (the last clause only when true, from the receipts) |
| Cancelled | "Stopped. It had {n} receipts before you stopped it." |
| Done | "{role} finished {task}." |

### 6.3 Mission control (owned by docs/design/run-trace-2026.md)

What this spec needs from the trace spec:
- **Branches:** a run's children shown as branches of the run, keyed by `childRunId`. Each branch carries the role, status, budget used / limit, the deadline and the last step.
- **List view:** all running and queued specialists across threads. Columns: role · title · thread · status · used / budget · deadline. Row actions: open, steer, pause, resume, cancel, more time.
- **Child view:** the child thread's transcript and step log, with the steer composer and the controls in §4.7.
- **Ids** (agreed with the trace spec): steps are keyed by `(runId, stepId)`.
  - Thinking steps use the `chat.reasoning` `stepId`.
  - Tool steps get a fresh Gateway `stp_` id; `ToolCall` gains `stepId`, and the step carries `toolCallId`.
  - The spawn's step is a `subagent` step with `childRunId` and `taskId`.
  - Child runs and threads get fresh ULIDs (the C6 `<parent>:sub:<id>` form can exceed `Id`'s 64 characters).
- **Not owned here:** layout, motion, density and what the run trace shows for non-specialist runs.

### 6.4 Settings → Specialists

One grouped list, one row per role:
- an on/off switch;
- the model (a picker over the router roles and allowlisted models);
- default and maximum budget (tokens, $, minutes);
- the max permission mode;
- "Show results in Feed".

Plus the global settings:
- concurrent specialists (1–6, default 3);
- monthly specialist spend cap (default: half of `usage.monthlyBudgetUsd` when set). When the cap is reached, spawns queue as "Waiting for budget".

Keys: `specialists.enabled.<role>`, `specialists.model.<role>`, `specialists.budget.<role>`, `specialists.maxMode.<role>`, `specialists.maxConcurrent`, `specialists.monthlyCapUsd`, `specialists.showInFeed`. All except `showInFeed` are admin settings (cost and permissions).

### 6.5 Voice

- A specialist is not a new persona. Chat lines and reports are the agent's voice; cards and errors are Psyche's voice.
- Role names are lowercase common nouns in prose ("the researcher") and sentence case as labels ("Researcher").
- The glossary gains one row: **specialist**, not sub-agent, worker or bot.

## 7. Protocol (additive)

### 7.1 Schemas

- **`Run`:** uses the trace spec's fields: `parentRunId?`, `rootRunId?`, `kind: chat | task | automation | subagent`, `taskId?`, `origin?`, `budget? {limit: {steps?, tokens?, wallMs?, costUsd?}, used: {steps, tokens, wallMs, costUsd?}}` and `deadline?`. `costUsd` (null for unpriced runs) and `specialist? {role}` are in the trace spec too (#664). Whichever of P0 and the trace spec's protocol PR (T1, #660) lands first defines these fields; the other reuses them.
- **`Task`:** gains `specialist?: SpecialistSpec`:

  ```ts
  SpecialistSpec {
    role: string,
    parentRunId: Id | null, parentThreadId: Id, rootRunId: Id | null,
    model: ModelRef,
    tools: string[],                 // the resolved allowlist
    permissionMode: PermissionMode,
    budget: {limit: {steps?, tokens?, wallMs?, costUsd?}, used: {steps, tokens, wallMs, costUsd}}, // the Run budget shape
    deadline: IsoDateTime | null,
    inputs: {libraryItemIds, folders, urls},
    deliver: "inbox" | "thread",
    result: SpecialistResult | null,
  }
  SpecialistResult {
    outcome: "done" | "partial" | "failed" | "cancelled",
    summary, findings[], artifacts[], next[], gaps[],
    receipts: Id[], tainted: boolean, evaluator?: {verdict, reason},
  }
  ```

- **`ApprovalHint`:** `{kind: ApprovalKind, label: string, estimate?: number}`, the spawn pre-flight.
- **`ApprovalRequest.requestedBy`:** gains `parentRunId?`, `specialist?`.
- **`NotificationKind`:** gains `specialist_result`. `Notification` gains `taskId`-based routing, already present.
- **`Automation`:** gains `specialist?: {role, budget?, deliver?}`.

### 7.2 Methods

| Method | Scope | What |
| --- | --- | --- |
| `specialists.list` | read | Roles from skills plus Settings: label, on, model, budget defaults and caps |
| `runs.children {runId}` | read | Child runs with status, role, used / budget, deadline, last step (for mission control) |
| `specialists.jobs {status?, threadId?}` | read | Running, queued and parked specialist tasks, newest first, with queue position |
| `tasks.steer {taskId, text}` | write | Steer a running specialist, or queue the text for its next turn |
| `tasks.update {taskId, budget?, deadline?}` | write | Owner-only budget or deadline change, capped by Settings |

`tasks.pause / resume / cancel / retry` exist already.

### 7.3 Events

| Event | Payload |
| --- | --- |
| `run.updated` | gains `run.parentRunId` (existing event) |
| `specialist.spawned` | `{taskId, runId, threadId, parentRunId, parentThreadId, role, title, status, position?}` |
| `specialist.progress` | `{taskId, runId, step: {id, label, status}, used, budget}`, at most one per child step, coalesced to ≤ 1/s |
| `specialist.result` | `{taskId, runId, parentRunId, result: SpecialistResult, notificationId}` |

`chat.reasoning` (#633) and `tool_call.updated` for the child thread flow as today; the trace subscribes to the child thread.

## 8. Plan: four workstreams

**Order:** P0 (protocol) first. Then R (runtime) and K (role skills) in parallel. U (UI) follows once P0 and the trace spec's protocol PR are merged; it builds against MockGateway fixtures and needs neither R nor K to land first.

Every PR:
- **Tests:** fixtures only, with the fixture provider (`FakeModelProvider` scripts or recorded router fixtures). No live model or app calls. Vitest runs with `--maxWorkers=1`, and only the changed packages are typechecked.
- **No dev runs** against the owner's `~/.psyche`.

### P0: protocol (one PR, first)

Brief:
> Add the background-specialist shapes from docs/agent/specialists-2026.md §7 to `packages/protocol`, additively.
>
> - **Schemas** (§7.1): `SpecialistSpec`, `SpecialistResult`, `ApprovalHint`, the optional `Run`, `Task`, `ApprovalRequest.requestedBy` and `Automation` fields, and the `specialist_result` notification kind (appended).
> - **Methods** (§7.2): `specialists.list`, `specialists.jobs`, `runs.children`, `tasks.steer`, `tasks.update`. `tasks.update` and `tasks.steer` are side-effecting with idempotency keys.
> - **Events** (§7.3): `specialist.spawned`, `specialist.progress`, `specialist.result`.
> - **Contract:** the `AgentEvent` member `{type: "subagent", runId, messageId, toolCallId, taskId, childRunId, status, label, progress?, usage?}`, matching the trace spec's `subagent` step.
> - **`Run` fields:** take the trace spec's `Run` fields from docs/design/run-trace-2026.md (`parentRunId`, `rootRunId`, `kind`, `taskId`, `origin`, `budget {limit, used}`, `deadline`), plus `costUsd` in both budget halves and `specialist {role}`. If the trace PR already added them, reuse them and add only what's missing.
> - **Fakes** in `packages/testing/src/fakes/`: `FakeTaskEngine` stores `specialist`, and `FakeAgentLoop` scripts the new event.
>
> Then:
> - add a CHANGES.md entry and a changeset;
> - run `pnpm protocol:gen` (TS, JSON Schema and Swift; the mac-helper generated file must match);
> - check `pnpm protocol:check`.
>
> Touch only `packages/protocol/**`, `packages/testing/src/fakes/**` and the generated files. Title: `protocol: background specialists (part of #682)`.

### R: runtime (agent-core, tasks, Gateway composition; one session)

Brief:
> You own the specialist runtime for docs/agent/specialists-2026.md §4: `packages/agent-core/src/specialists.ts` (new), the specialist pool in `packages/tasks`, and its composition in `apps/gateway/src/compose/`. Start after P0 merges.
>
> 1. **`specialist.spawn`, `specialist.report` and `specialist.status`** as agent-core built-ins (§4.1, §4.2). Resolve the role from `SkillLoader` (the `metadata.psyche.specialist` section; until K lands, use a fixture role). Then:
>    - clamp budget and deadline against the role and the `specialists.*` settings;
>    - create the Task (`createdFrom: "subagent"`, `specialist` spec, taint copied) and the child thread (kind `subagent`, incognito when the parent is);
>    - return at once and emit the `specialist` AgentEvent;
>    - withhold the tools listed in §4.3.
> 2. **Child runs:**
>    - the context is the role prompt, the brief, input references, and allowed `USER.md` facts only (§4.2);
>    - the tool set is the role allowlist ∩ the mode's tools ∩ toggles;
>    - the permission mode is `min(parent, role.maxMode)`, through a real `permissionModeFor`.
> 3. **Pool** (§4.5): a second `TaskWorkerPool` (`owner: "specialist"`, claim filter on `createdFrom`):
>    - 3 slots, FIFO queue with positions;
>    - parked jobs free their slot;
>    - at most 2 running per thread.
> 4. **Budgets and plan-first** (§4.1, §4.6):
>    - per-job `used` on the task (with `retried` for spend on retried errors), updated after every model call;
>    - an 80% `budget` step;
>    - at 100%, stop after the in-flight call and pause on the budget question card (Give it more / Finish with what it has / Stop it), with the clock stopped. In unattended runs, go straight to the wrap-up turn;
>    - at the deadline or on "Finish with what it has", run the tool-free wrap-up turn that writes a partial report;
>    - `planFirst` roles start in `plan` mode and continue only after the `plan_exit` card is approved;
>    - specialist questions require a `(Recommended)` option and honour the role's `proceedOnDefaultAfter`;
>    - cost skipped for unpriced runs;
>    - two failures on the same step end the job `failed`;
>    - the evaluator on `done`.
> 5. **Approvals** (§4.4): `requestedBy.parentRunId` and `specialist` set; the informational pre-flight from the role's `approvals`. Compute `newTarget` against the brief's targets and inputs, never the child's own reads.
> 6. **Delivery** (§4.2, §6.2):
>    - report text sanitized with `sanitizeBlock` before anyone reads it; `untrusted` when the job was tainted;
>    - one `specialist_result` notification per job;
>    - a `specialist.result` event;
>    - a system line in the parent thread;
>    - the parent run's `subagent` step updated when it is still open.
> 7. **Gateway methods:** `specialists.list`, `specialists.jobs`, `runs.children`, `tasks.steer` (AgentLoop.steer, or queued), `tasks.update` (owner-only, capped).
> 8. **Automations** (§4.10): the `specialist` field runs the automation as an unattended specialist job.
>
> Tests use the fixture provider only, with scripted `FakeModelProvider` turns:
> - spawn returns at once and the parent continues; a `planFirst` job waits on its plan card;
> - a budget hit pauses with the question card; "Give it more" resumes; "Finish" writes a partial report;
> - the child sees no parent transcript;
> - the allowlist and mode are clamped;
> - an approval parks the job and frees the slot; queue order;
> - a budget stop yields a partial report; deadline; retry with gaps;
> - taint copies in and out; an incognito parent;
> - cancel revokes; steer while running and while parked;
> - an automation-run specialist defers approvals.
>
> Typecheck `@psyche/agent-core`, `@psyche/tasks` and `@psyche/gateway`. Several PRs, each under about 800 lines:
> 1. spawn + child run + report;
> 2. pool and budgets;
> 3. approvals and pre-flight;
> 4. methods, delivery and automations.
>
> Title each `feat(agent): specialists — <part> (part of #683)`.

### K: role skills and prompts (content; one session, after P0)

Brief:
> You own `skills/specialist-*` and the specialist section of the base prompt for docs/agent/specialists-2026.md §4.8 and §5.
>
> - **Six role skills:** researcher, shopper, coder, organizer, writer, planner. Each has a `SKILL.md` with the `metadata.psyche.specialist` section from §5.1–5.2 and a role prompt that covers:
>   - objective and output format (the `specialist.report` fields for its `result` kind);
>   - effort guidance and stop criteria;
>   - tools and boundaries (the shopper never buys; the organizer never sends or deletes without a card; the planner changes nothing);
>   - "report what you could not do".
> - **For each role:** an `acceptance.md`, and two scripted fixtures in `examples/` (a `FakeModelProvider` script plus the expected report).
> - **Validation in `packages/skills`:** add the `specialist` section to the loader's schema. Tool patterns must resolve, and `maxMode` is capped for recipient and financial tools. Coordinate the loader change with S16's owner if it is busy; it is a schema addition.
> - **Base prompt:** a "Specialists" section with the delegate / don't rules of §4.8, under about 250 words.
> - **Existing skills:** `research-brief`, `shopping-compare` and `inbox-triage` each gain one line pointing at the matching specialist for long jobs.
> - **Delegation eval:** 30 scripted owner requests in `tests/scenarios/specialists/`, each labelled with the expected delegation (role or none), scored with the fixture provider.
>
> No live calls. Title: `feat(skills): specialist roles (part of #684)`.

### U: UI (packages/ui; one session, after P0)

Brief:
> You own the specialist surfaces in `packages/ui` for docs/agent/specialists-2026.md §6, against MockGateway fixtures (extend them with specialist jobs, results and events).
>
> 1. **Step log** (§6.1): the `subagent` RunStep kind (the trace spec's shape) in `RunStepLog.tsx`, with its label, last child step, budget ring past 50%, and open-child action.
> 2. **Result card** (§6.2): the Inbox row (two lines, role glyph) and the opened card. The card has the summary, findings or items, artifact chips, "What it did" receipts, usage against budget, the taint note, up to 2 `next` actions, Open thread, and Retry.
> 3. **Child view controls:** the steer composer, pause / resume / cancel and "Give it more time", using `tasks.*`. Mission control's layout belongs to docs/design/run-trace-2026.md: build these as components it can place, and coordinate with its owner (local_c5dec2ab) on where they mount.
> 4. **Settings → Specialists** (§6.4): grouped rows with the switch, model picker, budgets and max mode, plus the concurrency and monthly cap.
> 5. **Copy:** add the §6.2 strings to `docs/copy/system-messages.md` and the i18n catalogue, and the glossary row to `docs/copy/voice.md`.
>
> Follow docs/ui-audit.md and docs/design/redesign-2026.md. Strings go through the catalogue (`pnpm i18n:check`). Tests go in `packages/ui/test/`, plus stories. Typecheck `@psyche/ui` only. Title: `feat(ui): specialist step, result card and settings (part of #685)`.

### What each workstream must prove before its last PR merges

| Workstream | Proof |
| --- | --- |
| P0 | `protocol:check` clean; Swift generated file matches; protocol tests; fakes updated |
| R | fixture tests for every bullet of its brief; a Gateway compose test that a spawn → approval → partial → card round trip works on the fixture provider |
| K | loader validation tests; each role's two fixtures produce their expected report; the delegation eval scores ≥ 26 / 30 |
| U | MockGateway tests and stories for the step, card states (done, partial, failed, cancelled, needs you), controls and Settings; i18n clean; axe clean |

## 9. Risks

- **Runaway cost.** Research finds multi-agent runs use many times the tokens of a chat (see §2). Guards:
  - per-job budgets enforced by the runtime;
  - an 80% warning step;
  - a monthly specialist cap that queues new spawns;
  - at most 3 running, and at most 3 spawned per request;
  - owner-only budget raises;
  - cost on every card.
- **Approval fatigue.** Parallel jobs multiply cards. Guards:
  - read-first roles;
  - the pre-flight line, so the first card can be answered **Allow for this task**;
  - parked jobs that don't hold slots;
  - one Inbox card per job;
  - Feed off by default.
- **Taint laundering between agents.** A child's summary of untrusted content must not become trusted context for the parent, and an injected page must not steer a specialist into a write the owner never named. Guards:
  - the result is `untrusted` when the child was tainted;
  - the parent doesn't receive results into a live context unasked;
  - `newTarget` is computed against the brief, not the child's reads;
  - the pre-flight grants nothing, and every grant comes from a real card the owner answered;
  - no nesting in v1;
  - fork is off for specialists.
- **Lost track of parallel jobs.** Guards:
  - one mission-control list;
  - the parent step that persists;
  - queue positions;
  - exactly one delivery per job.
- **Overlong reports.** A summary capped at 600 chars, at most 12 findings, and artifacts for anything long.
- **Silent failure.** Every end state yields a card. The stall rule (`STALL_MS`, #630) applies to the child's steps too.
- **Scope creep.** Out of scope for v1 (#687), each with its own issue once v1 lands:
  - specialist-to-specialist handoffs;
  - nested specialists;
  - the parent agent steering children;
  - persona overlays per role;
  - third-party role marketplaces.
