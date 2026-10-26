# @psyche/agent-core

**Owner:** S02 (`prompts/s02-agent-runtime.md`). Features C1–C5, C8, C9, C11, B7 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md); C6, C7 and C10 are M2.

The agent loop: it turns a user message into model calls, tool calls, approvals, questions, plans and receipts. It implements `AgentLoop` from `@psyche/protocol` with pi-agent-core semantics (steer / follow-up queues, typed tools with `execute(callId, params, signal, onUpdate)`, before/after tool hooks, `finishTurn → end | continue`), and talks to everything else through contracts: `ModelProvider` (the model router, S03), `PermissionBroker` (S05), `MemoryStore` (S07), `SkillLoader` (S16), `TaskEngine` / `Scheduler` (S04), `Notifier` (S15).

## Public API

```ts
import { createAgentLoop, parseComposerInput } from "@psyche/agent-core";

const loop = createAgentLoop({
  provider,                 // ModelProvider (the router)
  model: "anthropic/claude-sonnet-5-5",
  utilityModel: "ollama/qwen3:8b", // compaction summaries
  broker,                   // PermissionBroker
  memory, skills, tasks, scheduler, notifier, // optional; built-ins register only for what is given
  state,                    // ThreadStateStore (default in-memory; the Gateway supplies a durable one)
  hooks: { before_tool_call: (ctx) => ({ action: "continue" }) },
  timeZone: "Europe/Berlin",
});

for await (const event of loop.startTurn({ threadId, runId, input: { text }, mode: "attended", permissionMode: "balanced" })) {
  // run.status, chat.delta, block, tool_call, approval_requested, question, usage, then exactly one end
}
```

| Member | What it does |
| --- | --- |
| `startTurn(input)` | One turn; the iterable ends after exactly one `end`. A second turn on a busy thread ends `failed` / `thread_busy` (the Gateway's session controller serializes). Stopping iteration cancels the run. |
| `steer(runId, text)` | Skips the rest of the current tool batch (each skipped call gets a result saying so) and adds the text as a user message before the next model call. |
| `followUp(threadId, text)` | Queued; runs inside the same run when the model would otherwise stop, one message at a time, in order. Queued on an idle thread, it runs after the next turn. |
| `cancel(runId)` | Aborts the model stream and tool waits, rejects open questions and calls `broker.revokeRunAuthority`. Dangling tool calls get `cancelled` results so the transcript stays a valid request. |
| `explainContext(runId)` | The exact system prompt, sections and tools of the run's latest model call (C11). Kept for the last 200 runs. |
| `answerQuestion(inputRequestId, answer)` | Answers an attended `ask_user` card. Answers are keyed by question `header` (as in `questions.answer`). |
| `openQuestions(threadId?)`, `getPlan(planId)`, `threadState(threadId)`, `isActive(threadId)` | Read helpers for the Gateway. |
| `registry` | The `ToolRegistry` (see below). |
| `hooks` | `HookRegistry`: `hooks.on(name, handler)` returns an unsubscribe. |
| `parseComposerInput(text)` | Slash commands → `ComposerIntent` (C9); `COMPOSER_COMMANDS` and `completeComposerCommand` feed autocompletion. |

Options worth knowing: `maxSteps` (50 model calls), `maxRunTokens` (2M input + output), `maxToolResultChars` (50k, cut with a marker), `budgets` (context budgets), `compaction` (`thresholdRatio` 0.75 of the model's context window, `keepRecentTurns` 2), `approvalSurfaces`, `planExitMode` (`balanced`), `toolToggles(threadId)`, `isIncognito(threadId)`, `finishTurn`, `onPermissionModeChange`.

## Hook order

```
startTurn
  │
  ├─ before_model_resolve ─────────── may swap the model (once per run)
  │
  └─ step (until final, budget, cancel or a parked question)
       ├─ assemble context ─ base → SOUL/IDENTITY/AGENTS/USER → skills → tools → daily notes → summary
       ├─ before_compaction ◄── only when over budget: MemoryStore.flush(private copy) runs first,
       │                         then the utility model summarizes older turns
       ├─ before_prompt_build ─────── may append sections, may narrow (never widen) the tools
       ├─ model stream ────────────── chat.delta, reasoning kept verbatim, tool_call(pending)
       └─ for each tool call, in order (consecutive read-only calls run concurrently once gated)
            ├─ validate params (invalid → error result, broker never sees it)
            ├─ before_tool_call ──── continue | block | suspend(approvalId) — never allow;
            │                         a throwing hook blocks (fail closed)
            ├─ PermissionBroker.decide(intent, {taint, taintSources, newTarget, requester, …})
            │     deny → blocked │ ask → ApprovalRequest → awaitDecision → verifyBinding
            │                     (unattended: queued + notification, not attempted)
            │     allow by a standing grant → the grant is re-read right before dispatch
            ├─ execute ───────────── tool_call(running, updates); ctx.authority says what allowed it
            ├─ after_tool_call ──── may mask the result, never lower its provenance
            ├─ receipt for write+ ─ broker.recordReceipt, receipt block
            └─ tool_result_persist ─ the tool_calls row (data model §2) for the Gateway
       steer queued → skip the rest, inject guidance, next step
       model stops → finishTurn → follow-up queue → end
  agent_end ───────────────────────── observes outcome, usage, steps
```

## Tool registration API

Other packages (browser, sandbox, connectors, nodes) register executors on `loop.registry`:

```ts
const off = loop.registry.register({
  spec: {
    name: "browser.navigate",          // connector tools: mcpToolName("notion", "search") → mcp__notion__search
    description: "Open a URL in the agent browser",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    sideEffect: "read",
    targetKind: "origin",
    provenanceOut: "untrusted",       // page content taints the turn
  },
  execute: async (callId, params, signal, onUpdate) => ({ output, provenance: "untrusted" }),
  // Optional, from protocol `ToolCallDescription`: per-call facts only you can compute.
  describeCall: (params) => ({
    target: { kind: "origin", value: new URL(params.url).origin },
    kind: "new_origin",
    bindingFields: { origin, taskId },  // data model §4.2; hashed into the approval's bindingHash
    summary: `Opened ${origin}`,        // the transcript's level-1 line
  }),
});
```

- `describeCall` can only make a call stricter: the loop uses the more severe of `spec.sideEffect` and `describeCall().sideEffect`.
- A result's provenance is the worse of the executor's and the spec's `provenanceOut`.
- Params are hashed (canonical JSON, security §3.5) for `paramsHash`; when `describeCall` gives `kind` and `bindingFields`, the loop computes `bindingHash` and re-verifies it with `verifyBinding` right before dispatch. `describeCall().grantKey` is namespaced by tool (`namespacedGrantKey` in the protocol: `<tool>|<key>`) so one tool's description can never borrow another's standing grants.
- In-process tools can use `defineTool({ name, input: TypeBoxSchema, sideEffect, run(params, ctx) })`: TypeBox schemas are JSON Schema, params are validated before the broker, and `ctx` (`ToolRunContext`) carries `threadId`, `runId`, `taskId`, `taint`, `taintSources`, `requester`, `approvalId`, `authority` and the abort signal. The prompt's "zod → JSON Schema" is satisfied by TypeBox, which the protocol already uses.
- **What authorized a call** (`ctx.authority`, protocol `ToolCallAuthority`): `{rule, bindingHash, grantKey?, approvalId?, grantId?, scope?}`. After an answered card it names the approval (and the grant a `task` / `site` / `session` / `always` answer created); after an `allow` by a standing grant it names the grant, which the loop re-reads from the ledger right before dispatch and fails closed if it is gone, revoked or expired. The loop stays the single verifier and consumer of `once` approvals; executors with their own enforcement (the connector registry, the browser) confirm, without consuming, that the approval or grant named here is live and covers the exact arguments they are about to send (`bindingHash` for an approval, the recomputed `grantKey` for a grant). The Gateway's `CallContexts.authorityFor(callId)` hands it to plain executors.
- **Who asked** (`StartTurnInput.requester`, protocol `Requester`, from S10's `RouteContext` via `requesterFromRoute(route)`): the loop passes it to `decide` and on the approval request's `context`, so the broker applies the person's own matrix and grants (S05 PR #89) and keeps their chat off the card. A non-owner's text is content: it taints the turn (`channel_message`, with the sender) and never counts as the owner's words for new-target matching, so every write of theirs to a target asks the owner.
- **Taint persistence** (S23 design-07/08): the final `tool_call` event of every call carries `details` (the `tool_calls` row: decision, rule, approval, `taintIn`, `taintOut`, provenance, receipt), so the Gateway stores taint with the result. `ThreadState.taint.sources` keeps the turn's sources while untrusted content remains in the transcript or summary, and the next turn, also after a Gateway restart with a durable store, starts tainted with them. `task.start` passes `taintSources` with `taint`, and a task run starts tainted with the task's sources until the owner re-approves its goal.
- Active tool set per model call: per-tool toggles (C3) → hook narrowing → unattended runs drop `ask_user` and `exit_plan_mode` → plan mode keeps only `sideEffect: none` tools (plus `exit_plan_mode`). A call to a hidden tool is blocked with the reason.

### Built-in tool shells

| Tool | Side effect | Delegates to |
| --- | --- | --- |
| `ask_user` | none | Attended: question card, run parks `awaiting_input`. Run with a task: `TaskEngine.requestInput`, run ends `awaiting_input`. |
| `update_plan` | none | Checklist (whole list, `advance`, `done` / `start`, exactly one `in_progress`), kept per thread, `checklist` block. |
| `wrap_up` | none | `wrap_up` block (recap ≤300, ask ≤100, 1–2 actions). |
| `exit_plan_mode` | none | `plan` block + `plan_exit` approval; on approval the run leaves plan mode (`planExitMode`). |
| `memory` | none; `write` + `memory_protected_write` for SOUL / IDENTITY / USER / MEMORY / AGENTS | `MemoryStore` (`memory_20250818` commands; daily notes append-only). Tainted turns write with `untrusted` provenance. |
| `task.start` | none | `TaskEngine.create` (inherits taint), `task` block. |
| `schedule` | write | `Scheduler.create` (unattended automation). |
| `notify` | write | `Notifier.notify`. |
| `subagent.spawn` | none | A child run of this loop (C6), below. |

### Subagents (C6)

`subagent.spawn {context: "fork" | "fresh", title, brief}` runs a child run to completion and returns `{subagentId, outcome, result, steps}` as the tool result: that is the announcement into the parent run.

- `fork` copies the parent's transcript (and compaction summary) up to the last fully answered step; `fresh` sees only the brief.
- Same model, permission mode, broker, hooks and tools, minus `ask_user`, `exit_plan_mode`, `wrap_up`, `subagent.spawn` (no nesting), `task.start`, `schedule`, `notify` and every tool whose `targetKind` is `recipient` (no messaging).
- No approval authority: a call the broker would `ask` about (or a hook would suspend) is blocked with a message telling the subagent to report instead; no approval request is issued.
- Taint flows both ways: a tainted parent starts the child tainted, and a tainted child makes its result `untrusted` and taints the parent.
- Budgets: `subagentMaxSteps` (20) per child; the child's tokens are added to the parent's `maxRunTokens`; at most `maxConcurrentSubagents` (4) at once. Parallel spawns in one model response run concurrently.
- Cancelling the parent cancels its children. `subagents(threadId)` lists them; each has its own thread (`<parent>:sub:<id>`) whose `threadState` is the view-only transcript, and `onSubagentEvent(info, event)` streams their events for the Subagents pane.

### Background specialists (docs/agent/specialists-2026.md, #683)

Unlike a subagent, a specialist runs a job **in the background** as a Task in its own thread and delivers one result. With `specialists: SpecialistHost` (the Gateway's `compose/specialists.ts`) and `tasks`, the loop registers three tools:

- `specialist.spawn {role, title, brief, inputs?, budget?, deadline?, deliver?, planFirst?}` builds the job's `SpecialistSpec` and hands it to the host, which creates the thread and the task. It returns at once with `{taskId, threadId, status, position?, preflight}` and emits a `subagent` event for the parent's step log.
  - **Budget:** requested, else the role default, capped by the role's caps.
  - **Deadline:** at most `maxHours`.
  - **Mode:** `min(parent, role.maxMode)`.
  - **Tools:** the role's resolved allowlist minus `SPECIALIST_WITHHELD`.
  - **Withheld** in plan mode, unattended runs, subagents and specialists; refused for non-owner requesters and unknown or disabled roles.
- `specialist.report {outcome, summary, findings?, artifacts?, next?, gaps?}` is specialist-only and delivers the job's one result through the host (sanitized and defused there; `untrusted` when the run was tainted). A second report is refused. A run that ends without one delivers a `partial` report built from its last message.
- `specialist.status {taskId?}` lists the thread's jobs; its output is `untrusted` when any result was tainted.

**A specialist's run** is a task run whose task has a `specialist` block:
- it uses the role's model (never a `/model` pin);
- its permission mode is `min(input, spec)`;
- its tools are the role allowlist plus `ask_user` and `specialist.report`;
- its system prompt is the base prompt, the role's prompt, and the persona files (`USER.md` only when the role's `memory` is `user`), with no skills index and no daily notes;
- its step budget comes from `budget.limit.steps`.

Owner runs that offer `specialist.spawn` get the "Specialists" prompt section (`specialistsPromptSection` from `@psyche/skills`). Still to come in later parts of #683: the specialist pool, budget pauses and plan-first, approval context, delivery cards and the `specialists.*` / `tasks.steer` / `tasks.update` handlers.

### Harness plugins (C10)

`loop.harnesses.register(plugin)` installs a coding harness (Claude Code, Codex, pi). A `HarnessPlugin` is `{id, name, available(), run(ctx)}`; its adapter turns the harness's own approval hook (Agent SDK `canUseTool`, Codex approval policy, pi `beforeToolCall`) into `ctx.gate(action)`, where the plugin classifies each action as `{tool, input, sideEffect, target?, summary}`.

- `harness.delegate {harness, cwd, brief}` (side effect `write`, target the folder) is offered only when a harness is installed, and never in plan mode or to subagents that would need approval.
- Every action is gated exactly like a native call named `harness__<id>__<tool>`: hooks, `decide`, the same approval card, binding verification. A denied action comes back to the harness as `{allowed: false, reason}`.
- The session is tainted from its first action (the harness reads repository files and the web), so writes to targets the owner did not name ask.
- `ctx.actionDone(actionId, outcome)` records a receipt for write+ actions; the report returns to the model as `untrusted`.
- Cancelling the run aborts the session through `ctx.signal`.

### Evaluator (C7)

When a run with a `taskId` would end `final` and the task has receipts, the loop checks them against the task's goal before the Gateway's task worker can mark it done (architecture §4.3 "Verification"):

- Failed receipts reopen the run with the gaps (`[evaluator] … Failed: …` as a user message); uncertain receipts escalate. No model call is needed for either.
- Otherwise the utility model (`evaluator.model`, else `utilityModel`) judges from the goal, the receipts and, for untainted runs only, the final report, and replies with a JSON verdict: `done | reopen | escalate` with gaps. An unparseable answer or a failed call escalates (fail closed).
- `reopen` continues the run up to `evaluator.maxReopens` (1) times; after that, or on `escalate`, an attended task run asks the owner ("Not verified": mark done / try again / I'll handle it) and ends `awaiting_input`; an unattended run ends `failed` with `not_verified: …`, so the owner is notified and the task is never reported done.
- A visible `[evaluator: …]` marker records each verdict. Disable with `evaluator: { enabled: false }`.

## Coding helper (V10)

`codingTools(deps)` returns `code.open`, `code.search`, `code.read`, `code.edit`, `code.run` and `code.git` (`src/coding/`). The Gateway registers them (`apps/gateway/src/compose/coding.ts`) with the P9 file tools' `read_file` / `write_file` registrations (reused for every read and write), the granted folders, a `SandboxRunner` (`code.run` runs in scope `project:<workspace>` with the repository at `/workspace/repo` and `.git` read-only; omitted without a runner), a `GitRunner` (host git, argv only; `code.git` is omitted without one) and the broker for receipts. Cards: `code.edit` is `file_write` with the whole patch, `code.run` is `exec`, `code.git` commit / branch are `git_write`, push is `git_push` (remote, URL, branch, commit; `once` only). Status and decisions: docs/status/s02.md "V10".

## How this maps to the docs

- Request lifecycle and runtime: [architecture §4.2–§4.3](../../docs/02-architecture.md); hook names: §13.
- Context assembly budgets and markers: architecture §4.2 step 3, feature C2. Golden prompt: `test/fixtures/prompt.golden.txt` (regenerate with `UPDATE_GOLDEN=1 pnpm vitest run test/context.test.ts`).
- Permission path, taint, approvals: [security §3.3, §3.5–§3.7](../../docs/05-security-and-permissions.md); injection stack §7 (untrusted content is fenced and labelled); memory safety §8.
- Blocks: [data model §9.1](../../docs/04-data-model.md); the `tool_result_persist` record is the `tool_calls` row of §2.

## What is stubbed or deferred

- No concrete harness adapter ships yet: the Claude Code / Codex / pi adapters are plugins built on this seam.
- `memory` `delete` / `rename` return `not_implemented` until `MemoryStore` has them (S07).
- The default `ThreadStateStore` is in memory; the Gateway (S01) persists threads. Until it supplies a durable store, a Gateway restart loses the model transcript and with it the thread's saved taint sources (the `tool_calls` rows keep per-call taint).
- The SQLite task engine (S04) persists `taint` but not yet `taintSources`; the fake keeps both.
- Tool names with dots (`task.start`) are kept; the model router (S03) maps names a provider rejects.
- Taint detection in injected daily notes relies on the `[untrusted]` line tag the memory store writes.
