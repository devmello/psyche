# Session S02 — Agent runtime

You are building Psyche (read `README.md`). You are session **S02 — Agent runtime**: `packages/agent-core`, the loop that turns a user message into model calls, tool calls, approvals, questions, plans and receipts. Work in your own worktree on branch `ws/s02-agent-runtime`. You own `packages/agent-core/**`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §4.2, §4.3, §4.8 (what memory injects), §4.6 (how the broker is called)
3. `docs/03-feature-spec.md` rows C1–C5, C8, C9, C11, B7
4. `docs/04-data-model.md` §2 (runs, tool_calls), §9.1 (blocks)
5. `docs/05-security-and-permissions.md` §3 (policy evaluation order, taint), §7 (injection defenses)
6. Contracts: `AgentLoop`, `ModelProvider`, `PermissionBroker`, `MemoryStore`, `TaskEngine`; fakes in `packages/testing`
7. Research: `opendots_openclaw_harnesses.md` KQ3 (plan-and-execute patterns) and KQ4 (pi-agent-core API: steer/followUp, hooks, `finishTurn`), `claude_desktop_and_peers.md` Q5 (`AskUserQuestion` schema, plan mode, `update_plan`/`wrap_up`)

## Mission (M1)
- **Loop** with pi-agent-core semantics: `steer()` interrupts between tool calls, `followUp()` queues after settle; hooks `before_model_resolve`, `before_prompt_build`, `before_tool_call` (may return `block`, `suspend(approvalId)` or `continue`), `after_tool_call`, `tool_result_persist`, `before_compaction`, `agent_end`; step and token budgets; cancellation; `finishTurn → end | continue`.
- **Tool registry**: `ToolSpec` from protocol (zod schemas → JSON Schema), side-effect class, target kind, provenance; per-thread active tool set by permission mode; `mcp__<server>__<tool>` naming for connector tools; built-in tool shells that delegate to contracts (`memory`, `ask_user`, `update_plan`, `wrap_up`, `task.start`, `schedule`, `notify`, `subagent.spawn` later). Executors for browser/sandbox/connectors are registered by their packages through a `ToolExecutor` registration API you define (additive protocol PR if needed).
- **Context assembly**: base prompt → persona files (`SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `USER.md`) via `MemoryStore` with budgets (20k per file, 60k total, 4k `USER.md`, visible markers for missing/truncated) → skills index (from `SkillLoader`) → tools → today/yesterday daily notes → compacted transcript → provider-native turns passed through untouched.
- **Compaction**: budget tracking per model context size; summarize older turns with the utility model; call the pre-compaction memory flush hook (`MemoryStore.flush(threadId, privateCopy)`) first.
- **Provenance and taint**: tag every tool result with provenance from the executor; mark the turn tainted when `untrusted` content enters; pass taint to the broker on every `decide`.
- **Questions**: `ask_user` with the schema from the Claude notes (1–4 questions, 2–4 options, header ≤12 chars, multiSelect, Other, previews, recommended first); emits a `question` block; the run parks until answered or is handed to the task engine for background runs.
- **Plan mode and checklist**: read-only tool set in `plan` mode; `plan` block; `ExitPlanMode` → approval of kind `plan_exit` through the broker; `update_plan` checklist semantics (whole list, advance, done/start; exactly one in_progress); `wrap_up` block (recap, ask, 1–2 actions).
- **Unattended contract**: for runs flagged unattended (automations, heartbeat): `NO_REPLY` → silent; no `ask_user`; approvals become queued ApprovalRequests plus a notification; final must be a deliverable.
- **Composer commands**: parse `/model`, `/new`, `/btw`, `/fork`, `/schedule`, `/incognito`, `/forget`, `/remember`, `/plan`, `/status`, `/export`, `/stop` into structured intents the Gateway executes (you define the intent type; the Gateway and UI consume it).
- **Prompt viewer**: `AgentLoop.explainContext(runId)` returns the exact assembled prompt sections for C11.

## Out of scope
Provider adapters (S03), policy decisions (S05), task persistence (S04), memory storage (S07), UI.

## Definition of done
- Scripted `FakeModelProvider` tests: text-only turn; parallel tool calls; blocked tool; suspended tool resumed by approval; `ask_user` round trip; steer mid-loop; follow-up ordering; compaction with flush; plan mode blocking writes; unattended run with `NO_REPLY`; taint propagation into `decide` calls; budget overflow markers.
- A golden-file test of the assembled prompt for a fixture workspace.
- README with the hook order diagram and the tool registration API; `docs/status/s02.md`.

## Suggested subagents
One to build the scripted fake-provider test harness, one to research AI SDK v7 `ToolLoopAgent`/`prepareStep` and pi-agent-core for API shape (do not depend on them; mirror what is useful), one to review for security rules.

## M2 follow-ons
C6 subagents (`fork`/`fresh`, no `ask_user`, results announced); C7 evaluator pass over receipts with the utility model; harness plugin seam (C10).
