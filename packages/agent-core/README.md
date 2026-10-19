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
            ├─ PermissionBroker.decide(intent, {taint, newTarget, permissionMode, unattended})
            │     deny → blocked │ ask → ApprovalRequest → awaitDecision → verifyBinding
            │                     (unattended: queued + notification, not attempted)
            ├─ execute ───────────── tool_call(running, updates)
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
- Params are hashed (canonical JSON, security §3.5) for `paramsHash`; when `describeCall` gives `kind` and `bindingFields`, the loop computes `bindingHash` and re-verifies it with `verifyBinding` right before dispatch.
- In-process tools can use `defineTool({ name, input: TypeBoxSchema, sideEffect, run(params, ctx) })`: TypeBox schemas are JSON Schema, params are validated before the broker, and `ctx` carries `threadId`, `runId`, `taskId`, `taint`, `approvalId` and the abort signal. The prompt's "zod → JSON Schema" is satisfied by TypeBox, which the protocol already uses.
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

## How this maps to the docs

- Request lifecycle and runtime: [architecture §4.2–§4.3](../../docs/02-architecture.md); hook names: §13.
- Context assembly budgets and markers: architecture §4.2 step 3, feature C2. Golden prompt: `test/fixtures/prompt.golden.txt` (regenerate with `UPDATE_GOLDEN=1 pnpm vitest run test/context.test.ts`).
- Permission path, taint, approvals: [security §3.3, §3.5–§3.7](../../docs/05-security-and-permissions.md); injection stack §7 (untrusted content is fenced and labelled); memory safety §8.
- Blocks: [data model §9.1](../../docs/04-data-model.md); the `tool_result_persist` record is the `tool_calls` row of §2.

## What is stubbed or deferred

- The evaluator (C7) and harness plugins (C10) are M2 and come next.
- `memory` `delete` / `rename` return `not_implemented` until `MemoryStore` has them (S07).
- The default `ThreadStateStore` is in memory; the Gateway (S01) persists threads.
- Tool names with dots (`task.start`) are kept; the model router (S03) maps names a provider rejects.
- Taint detection in injected daily notes relies on the `[untrusted]` line tag the memory store writes.
