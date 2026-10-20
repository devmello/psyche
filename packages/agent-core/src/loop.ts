import {
  type AgentEvent,
  type AgentLoop,
  type ApprovalKind,
  type Block,
  type Clock,
  type ContextExplanation,
  type ContextSection,
  type DecisionResult,
  EMPTY_USAGE,
  type InputRequest,
  type MemoryStore,
  type ModelCapabilities,
  type ModelMessage,
  type ModelPart,
  type ModelProvider,
  type ModelRef,
  type Notifier,
  namespacedGrantKey,
  type PermissionBroker,
  type PermissionMode,
  type ProvenanceOut,
  PsycheError,
  type Question,
  type Requester,
  type RunOutcome,
  type RunStatus,
  type Scheduler,
  type SideEffect,
  type SkillLoader,
  type StartTurnInput,
  type Surface,
  type TaintSource,
  type Target,
  type TaskEngine,
  type ToolCall,
  type ToolCallAuthority,
  type ToolCallDescription,
  type ToolCallDetails,
  type ToolCallStatus,
  type ToolResult,
  type ToolSpec,
  type ToolUpdate,
  type Usage,
} from "@psyche/protocol";
import {
  type HarnessAction,
  type HarnessGateResult,
  HarnessRegistry,
  harnessDelegateTool,
} from "./builtins/harness.ts";
import { memoryTool, notifyTool, scheduleTool, taskStartTool } from "./builtins/services.ts";
import {
  type SpawnSubagentInput,
  type SubagentResult,
  type TurnApi,
  type TurnToolContext,
  turnTools,
} from "./builtins/turn.ts";
import {
  type CompactionPolicy,
  containsUntrusted,
  DEFAULT_COMPACTION_POLICY,
  estimateContextTokens,
  splitForCompaction,
  summarize,
} from "./compaction.ts";
import {
  assembleContext,
  type ContextBudgets,
  DEFAULT_BASE_PROMPT,
  DEFAULT_CONTEXT_BUDGETS,
  renderSystemPrompt,
} from "./context.ts";
import { type Evaluation, evaluateTask } from "./evaluator.ts";
import { EventQueue } from "./events.ts";
import { type HookMap, HookRegistry } from "./hooks.ts";
import { type QuestionAnswer, validateAnswer } from "./questions.ts";
import { type AgentToolRegistration, AgentToolRegistry } from "./registry.ts";
import {
  emptyThreadState,
  InMemoryThreadStateStore,
  type ThreadState,
  type ThreadStateStore,
} from "./state.ts";
import {
  bindingHash,
  dedupeSources,
  deferred,
  errorMessage,
  type IdSource,
  paramsHash,
  randomIds,
  SEVERITY,
  sha256,
  stricter,
  systemClock,
  toIso,
} from "./util.ts";

type MaybePromise<T> = T | Promise<T>;

/** `finishTurn` (pi-agent-core): when the model would stop, end or continue with a message. */
export type FinishTurnDecision = "end" | { action: "continue"; message: string };

export interface FinishTurnContext {
  threadId: string;
  runId: string;
  text: string;
  steps: number;
}

export interface AgentLoopOptions {
  /** The model router (S03) or any `ModelProvider`. */
  provider: ModelProvider;
  model: ModelRef;
  /** Utility model for compaction summaries (architecture §4.4 roles); defaults to `model`. */
  utilityModel?: ModelRef;
  broker: PermissionBroker;
  memory?: MemoryStore;
  skills?: SkillLoader;
  tasks?: TaskEngine;
  notifier?: Notifier;
  scheduler?: Scheduler;
  registry?: AgentToolRegistry;
  /** Register the built-in tool shells (default true). */
  builtins?: boolean;
  state?: ThreadStateStore;
  hooks?: HookRegistry | HookMap;
  clock?: Clock;
  ids?: IdSource;
  /** IANA zone for daily notes (default UTC). */
  timeZone?: string;
  basePrompt?: string;
  budgets?: Partial<ContextBudgets>;
  compaction?: Partial<CompactionPolicy>;
  /** Model calls per run (default 50). */
  maxSteps?: number;
  /** Input + output tokens per run (default 2,000,000). */
  maxRunTokens?: number;
  /** Characters of one tool result sent to the model (default 50,000). */
  maxToolResultChars?: number;
  approvalSurfaces?: Surface[];
  /** Mode a thread moves to when its plan is approved (default `balanced`). */
  planExitMode?: PermissionMode;
  toolToggles?: (threadId: string) => Record<string, boolean> | undefined;
  /** Incognito threads are never flushed to memory (security §8). */
  isIncognito?: (threadId: string) => boolean;
  finishTurn?: (ctx: FinishTurnContext) => MaybePromise<FinishTurnDecision>;
  onPermissionModeChange?: (threadId: string, mode: PermissionMode) => void;
  /** Runs whose prompt `explainContext` keeps (default 200). */
  explainHistory?: number;
  /** Model calls per subagent run (default 20); they also count toward the parent's tokens. */
  subagentMaxSteps?: number;
  /** Subagents one run may have in flight at once (default 4). */
  maxConcurrentSubagents?: number;
  /**
   * C7 evaluator for task runs that produced receipts (default on when `tasks` is given). Uses
   * `model`, else `utilityModel`, else the run's model.
   */
  evaluator?: { enabled?: boolean; model?: ModelRef; maxReopens?: number };
  /** Coding harness plugins (C10); `harness.delegate` is offered when one is registered. */
  harnesses?: HarnessRegistry;
  /** Every event of a subagent run, for the Subagents pane's view-only transcript (C6). */
  onSubagentEvent?: (info: SubagentInfo, event: AgentEvent) => void;
}

/** A subagent run (C6), listed for the Subagents pane. */
export interface SubagentInfo {
  id: string;
  parentRunId: string;
  parentThreadId: string;
  /** The subagent's own thread; `threadState(threadId)` is its view-only transcript. */
  threadId: string;
  runId: string;
  context: "fork" | "fresh";
  title: string;
  status: "running" | "final" | "failed" | "cancelled";
}

interface ChildSpec {
  parent: RunState;
  messages: ModelMessage[];
  summary?: ThreadState["summary"];
  maxSteps: number;
}

interface PendingQuestion {
  request: InputRequest;
  resolve: (answer: QuestionAnswer) => void;
  reject: (err: unknown) => void;
}

interface RunState {
  runId: string;
  threadId: string;
  taskId?: string;
  mode: StartTurnInput["mode"];
  permissionMode: PermissionMode;
  /** The owner's own words this turn (target matching); empty for a non-owner requester. */
  ownerText: string;
  /** Who asked for the turn (security §9); absent means the owner. */
  requester?: Requester;
  abort: AbortController;
  steer: string[];
  taint: boolean;
  taintSources: TaintSource[];
  /** Targets the owner's request or an earlier approval in this run covers. */
  targets: Set<string>;
  usage: Usage;
  steps: number;
  model: ModelRef;
  thread: ThreadState;
  messageId: string;
  parked?: InputRequest;
  questions: Map<string, PendingQuestion>;
  active: Map<string, AgentToolRegistration>;
  hidden: Map<string, string>;
  emit: (event: AgentEvent) => void;
  /** Set for a subagent run: no questions, messaging, approvals or nesting (C6). */
  subagent?: { parentRunId: string; maxSteps: number };
  /** Subagents of this run currently in flight. */
  children: number;
  /** Times the evaluator reopened this run (C7). */
  reopens: number;
  /** Harness actions gated in this run, and those allowed but not yet reported (C10). */
  harnessActions: number;
  harnessPending: Map<string, Gated>;
}

interface Gated {
  call: { id: string; name: string; input: unknown };
  reg: AgentToolRegistration;
  desc: ToolCallDescription;
  sideEffect: SideEffect;
  target?: Target;
  /**
   * The arguments as gated (security §3.5): a private copy taken before hashing, so what the
   * broker decided, the owner approved and the executor receives are the same bytes (#70).
   */
  args: unknown;
  hash: string;
  decision?: DecisionResult;
  approvalKind?: ApprovalKind;
  approvalId?: string;
  /** What authorized the dispatch, once the gate let the call through. */
  authority?: ToolCallAuthority;
  taintIn: boolean;
  startedAt: string;
}

type GateOutcome = { proceed: Gated } | { done: ModelPart };

const READ_ONLY: ReadonlySet<SideEffect> = new Set(["none", "read"]);
const INTERACTIVE = new Set(["ask_user", "exit_plan_mode"]);
const NO_REPLY = "NO_REPLY";
const NO_APPROVAL_AUTHORITY =
  "needs the owner's approval, and subagents cannot ask: report what you would do and why";

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    costUsd: a.costUsd + b.costUsd,
  };
}

function runStatusOf(outcome: RunOutcome): RunStatus {
  switch (outcome) {
    case "final":
    case "no_reply":
      return "done";
    case "awaiting_approval":
      return "awaiting_approval";
    case "awaiting_input":
      return "awaiting_input";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

class RunEnd extends Error {
  readonly outcome: RunOutcome;
  readonly reason: string | undefined;

  constructor(outcome: RunOutcome, reason?: string) {
    super(reason ?? outcome);
    this.outcome = outcome;
    this.reason = reason;
  }
}

/**
 * The agent loop (architecture §4.2–§4.3; features C1–C5, C8, C11, B7). One turn at a time per
 * thread; see README.md for the hook order.
 */
export class PsycheAgentLoop implements AgentLoop {
  readonly registry: AgentToolRegistry;
  readonly hooks: HookRegistry;
  readonly harnesses: HarnessRegistry;
  #o: AgentLoopOptions;
  #clock: Clock;
  #ids: IdSource;
  #state: ThreadStateStore;
  #budgets: ContextBudgets;
  #policy: CompactionPolicy;
  #runs = new Map<string, RunState>();
  #threads = new Map<string, { activeRunId?: string; followUps: string[] }>();
  #explanations = new Map<string, ContextExplanation>();
  #plans = new Map<string, { threadId: string; title: string; plan: string }>();
  #capabilities = new Map<string, Promise<ModelCapabilities>>();
  #subagents = new Map<string, SubagentInfo>();

  constructor(options: AgentLoopOptions) {
    this.#o = options;
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? randomIds;
    this.#state = options.state ?? new InMemoryThreadStateStore();
    this.#budgets = { ...DEFAULT_CONTEXT_BUDGETS, ...options.budgets };
    this.#policy = { ...DEFAULT_COMPACTION_POLICY, ...options.compaction };
    this.hooks =
      options.hooks instanceof HookRegistry ? options.hooks : new HookRegistry(options.hooks);
    this.registry = options.registry ?? new AgentToolRegistry();
    this.harnesses = options.harnesses ?? new HarnessRegistry();
    if (options.builtins !== false) this.#registerBuiltins();
  }

  #registerBuiltins(): void {
    const o = this.#o;
    const tz = o.timeZone ?? "UTC";
    const tools: AgentToolRegistration[] = [...turnTools()];
    if (o.memory !== undefined)
      tools.push(memoryTool(o.memory, { clock: this.#clock, timeZone: tz }));
    if (o.tasks !== undefined) tools.push(taskStartTool(o.tasks));
    if (o.scheduler !== undefined) tools.push(scheduleTool(o.scheduler, tz));
    if (o.notifier !== undefined) tools.push(notifyTool(o.notifier));
    tools.push(harnessDelegateTool(this.harnesses));
    for (const tool of tools) {
      if (this.registry.get(tool.spec.name) === undefined) this.registry.register(tool);
    }
  }

  // --- AgentLoop --------------------------------------------------------------------------------

  async *startTurn(input: StartTurnInput): AsyncIterable<AgentEvent> {
    const queue = new EventQueue<AgentEvent>();
    let ended = false;
    const emit = (event: AgentEvent) => {
      if (ended) return;
      if (event.type === "end") ended = true;
      queue.push(event);
    };
    const done = this.#execute(input, emit).finally(() => queue.close());
    try {
      for await (const event of queue) yield event;
    } finally {
      // A consumer that stops listening cancels the run (it cannot see approvals any more).
      if (!ended) await this.cancel(input.runId, "consumer stopped");
      await done;
    }
  }

  async steer(runId: string, text: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (run === undefined) throw new PsycheError("not_found", `run ${runId} is not active`);
    run.steer.push(text);
  }

  async followUp(threadId: string, text: string): Promise<void> {
    this.#thread(threadId).followUps.push(text);
  }

  async cancel(runId: string, reason = "cancelled"): Promise<void> {
    const run = this.#runs.get(runId);
    if (run !== undefined && !run.abort.signal.aborted) {
      run.abort.abort(new RunEnd("cancelled", reason));
      for (const q of run.questions.values()) q.reject(new RunEnd("cancelled", reason));
      run.questions.clear();
    }
    // Revoked even when the run already parked or ended: no late approval may act for it.
    await this.#o.broker.revokeRunAuthority(runId);
  }

  async explainContext(runId: string): Promise<ContextExplanation | undefined> {
    const e = this.#explanations.get(runId);
    return e === undefined ? undefined : structuredClone(e);
  }

  // --- Extras the Gateway uses ------------------------------------------------------------------

  /** Answer an attended `ask_user` question (keys are question headers). */
  async answerQuestion(inputRequestId: string, answer: QuestionAnswer): Promise<InputRequest> {
    for (const run of this.#runs.values()) {
      const pending = run.questions.get(inputRequestId);
      if (pending === undefined) continue;
      validateAnswer(pending.request.questions, answer);
      run.questions.delete(inputRequestId);
      const answered: InputRequest = {
        ...pending.request,
        status: "answered",
        answer: structuredClone(answer),
        answeredAt: toIso(this.#clock.now()),
      };
      pending.resolve(answer);
      return answered;
    }
    throw new PsycheError("not_found", `no open question ${inputRequestId}`);
  }

  /** Open attended questions (for a reconnecting client). */
  openQuestions(threadId?: string): InputRequest[] {
    return [...this.#runs.values()]
      .filter((r) => threadId === undefined || r.threadId === threadId)
      .flatMap((r) => [...r.questions.values()].map((q) => structuredClone(q.request)));
  }

  getPlan(planId: string): { threadId: string; title: string; plan: string } | undefined {
    const p = this.#plans.get(planId);
    return p === undefined ? undefined : { ...p };
  }

  /** The thread's checklist, transcript and summary (read-only copy). */
  async threadState(threadId: string): Promise<ThreadState> {
    return (await this.#state.load(threadId)) ?? emptyThreadState();
  }

  isActive(threadId: string): boolean {
    return this.#threads.get(threadId)?.activeRunId !== undefined;
  }

  // --- The run ----------------------------------------------------------------------------------

  #thread(threadId: string) {
    let t = this.#threads.get(threadId);
    if (t === undefined) {
      t = { followUps: [] };
      this.#threads.set(threadId, t);
    }
    return t;
  }

  async #execute(
    input: StartTurnInput,
    emit: (e: AgentEvent) => void,
    child?: ChildSpec,
  ): Promise<RunState | undefined> {
    const { runId, threadId } = input;
    const thread = this.#thread(threadId);
    if (thread.activeRunId !== undefined || this.#runs.has(runId)) {
      emit({ type: "end", runId, outcome: "failed", error: "thread_busy" });
      return undefined;
    }
    thread.activeRunId = runId;
    const abort = new AbortController();
    const onExternalAbort = () => void this.cancel(runId, "signal");
    input.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const requester = input.requester;
    const ownerSent = requester === undefined || requester.role === "owner";
    const run: RunState = {
      runId,
      threadId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      mode: input.mode,
      permissionMode: input.permissionMode,
      // Only the owner's words name targets the agent may act on (security §3.6, §9).
      ownerText: ownerSent ? input.input.text : "",
      ...(requester === undefined ? {} : { requester }),
      abort,
      steer: [],
      taint: false,
      taintSources: [],
      targets: new Set(),
      usage: { ...EMPTY_USAGE },
      steps: 0,
      model: this.#o.model,
      thread: emptyThreadState(),
      messageId: this.#ids.next("msg"),
      questions: new Map(),
      active: new Map(),
      hidden: new Map(),
      emit,
      children: 0,
      reopens: 0,
      harnessActions: 0,
      harnessPending: new Map(),
      ...(child === undefined
        ? {}
        : { subagent: { parentRunId: child.parent.runId, maxSteps: child.maxSteps } }),
    };
    this.#runs.set(runId, run);
    let outcome: RunOutcome = "final";
    let error: string | undefined;
    try {
      if (input.signal?.aborted === true) throw new RunEnd("cancelled", "signal");
      emit({ type: "run.status", runId, status: "running" });
      run.thread =
        child === undefined
          ? ((await this.#state.load(threadId)) ?? emptyThreadState())
          : {
              messages: child.messages,
              checklist: [],
              ...(child.summary === undefined ? {} : { summary: child.summary }),
            };
      // A subagent works for a parent that may already have read untrusted content; it starts
      // with the parent's sources so its cards name the real origins (design-08).
      if (child?.parent.taint === true) {
        this.#taint(run, { sourceKind: "parent" });
        for (const s of child.parent.taintSources) this.#taint(run, { ...s });
      }
      // Untrusted content still in context keeps steering the model, so the turn starts
      // tainted while it is there (security §3.6: taint survives compaction, and the saved
      // sources survive a kill/restart with the thread state).
      if (containsUntrusted(run.thread.messages) || run.thread.summary?.untrusted === true) {
        this.#taint(run, { sourceKind: "transcript" });
        for (const s of run.thread.taint?.sources ?? []) this.#taint(run, { ...s });
      }
      if (input.taskId !== undefined && this.#o.tasks !== undefined) {
        const task = await this.#o.tasks.get(input.taskId);
        // A Task created from a tainted turn inherits the taint and its sources, for every run
        // until the owner re-approves its goal (architecture §4.6; design-08).
        if (task?.taint === true) {
          this.#taint(run, { sourceKind: "task" });
          for (const s of task.taintSources ?? []) this.#taint(run, { ...s });
        }
      }
      // A non-owner's message is content, never instructions (security §3.6, §9).
      if (!ownerSent && requester !== undefined) {
        this.#taint(run, {
          sourceKind: "channel_message",
          ...(requester.channel === undefined && requester.senderId === undefined
            ? {}
            : { sender: `${requester.channel ?? "?"}:${requester.senderId ?? "?"}` }),
        });
      }
      run.model = await this.#resolveModel(run);
      run.thread.messages.push({ role: "user", parts: [{ type: "text", text: userText(input) }] });
      outcome = await this.#loop(run);
    } catch (err) {
      const end = err instanceof RunEnd ? err : (abortReason(run) ?? undefined);
      if (end !== undefined) {
        outcome = end.outcome;
        if (end.outcome === "failed") error = end.reason;
      } else {
        outcome = "failed";
        error = errorMessage(err);
      }
    } finally {
      input.signal?.removeEventListener("abort", onExternalAbort);
      closeDanglingCalls(run.thread.messages, outcome === "cancelled" ? "cancelled" : "not run");
      for (const q of run.questions.values()) q.reject(new RunEnd("cancelled"));
      // The sources outlive the turn with the untrusted content that caused them.
      if (run.taint) run.thread.taint = { sources: dedupeSources(run.taintSources) };
      else delete run.thread.taint;
      try {
        await this.#state.save(threadId, run.thread);
      } catch (err) {
        if (outcome !== "failed") {
          outcome = "failed";
          error = `could not save the thread: ${errorMessage(err)}`;
        }
      }
      this.#runs.delete(runId);
      thread.activeRunId = undefined;
    }
    for (const hook of this.hooks.handlers("agent_end")) {
      try {
        await hook({
          threadId,
          runId,
          ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
          outcome,
          usage: { ...run.usage },
          steps: run.steps,
          ...(error === undefined ? {} : { error }),
        });
      } catch {
        // agent_end observes; it cannot change the outcome.
      }
    }
    emit({ type: "usage", runId, usage: { ...run.usage } });
    emit({ type: "run.status", runId, status: runStatusOf(outcome) });
    emit({ type: "end", runId, outcome, ...(error === undefined ? {} : { error }) });
    return run;
  }

  async #resolveModel(run: RunState): Promise<ModelRef> {
    let model = run.model;
    for (const hook of this.hooks.handlers("before_model_resolve")) {
      const r = await hook({ ...runRef(run), model });
      if (r?.model !== undefined) model = r.model;
    }
    return model;
  }

  async #loop(run: RunState): Promise<RunOutcome> {
    const maxSteps = run.subagent?.maxSteps ?? this.#o.maxSteps ?? 50;
    const maxTokens = this.#o.maxRunTokens ?? 2_000_000;
    let pendingText = "";
    for (;;) {
      this.#checkAbort(run);
      if (run.steps >= maxSteps) {
        this.#marker(run, `[stopped: step budget of ${maxSteps} model calls reached]`);
        throw new RunEnd("failed", "step_budget_exceeded");
      }
      run.steps += 1;
      run.messageId = run.steps === 1 ? run.messageId : this.#ids.next("msg");
      const { system, tools } = await this.#prepare(run);
      const step = await this.#callModel(run, system, tools);
      if (step.parts.length > 0) run.thread.messages.push({ role: "assistant", parts: step.parts });
      run.emit({ type: "usage", runId: run.runId, usage: { ...run.usage } });
      if (step.finish === "cancelled") throw new RunEnd("cancelled");
      if (step.finish === "error") throw new RunEnd("failed", step.error ?? "model error");
      if (run.usage.input + run.usage.output > maxTokens) {
        this.#marker(
          run,
          `[stopped: token budget of ${maxTokens.toLocaleString("en-US")} reached]`,
        );
        throw new RunEnd("failed", "token_budget_exceeded");
      }

      if (step.calls.length > 0) {
        const results = await this.#runTools(run, step.calls);
        run.thread.messages.push({ role: "tool", parts: results });
        if (run.parked !== undefined) return "awaiting_input";
        this.#checkAbort(run);
        this.#drainSteer(run);
        continue;
      }

      // The model would stop: finishTurn → end | continue (pi-agent-core).
      pendingText += step.text;
      if (this.#drainSteer(run)) continue;
      const decision = await this.#finishDecision(run, step.text);
      if (decision !== "end") {
        this.#flushUnattended(run, pendingText);
        pendingText = "";
        run.thread.messages.push({
          role: "user",
          parts: [{ type: "text", text: decision.message }],
        });
        continue;
      }
      const followUp = this.#thread(run.threadId).followUps.shift();
      if (followUp !== undefined) {
        this.#flushUnattended(run, pendingText);
        pendingText = "";
        run.ownerText += `\n${followUp}`;
        run.thread.messages.push({ role: "user", parts: [{ type: "text", text: followUp }] });
        continue;
      }
      if (run.mode === "unattended") {
        const final = pendingText.trim();
        if (final === NO_REPLY) return "no_reply";
        if (final === "") throw new RunEnd("failed", "empty_final");
      }
      // C7: a task's run is checked against its receipts before it may end as done.
      const evaluation = await this.#evaluate(run, pendingText);
      if (evaluation !== undefined && evaluation.verdict !== "done") {
        const maxReopens = this.#o.evaluator?.maxReopens ?? 1;
        if (evaluation.verdict === "reopen" && run.reopens < maxReopens) {
          run.reopens += 1;
          pendingText = "";
          run.thread.messages.push({
            role: "user",
            parts: [{ type: "text", text: reopenMessage(evaluation) }],
          });
          continue;
        }
        return this.#escalate(run, evaluation);
      }
      if (run.mode === "unattended") {
        run.emit({
          type: "chat.delta",
          runId: run.runId,
          messageId: run.messageId,
          delta: pendingText,
        });
      }
      return "final";
    }
  }

  async #evaluate(run: RunState, finalText: string): Promise<Evaluation | undefined> {
    const tasks = this.#o.tasks;
    if (run.taskId === undefined || tasks === undefined || run.subagent !== undefined)
      return undefined;
    if (this.#o.evaluator?.enabled === false) return undefined;
    const receipts = await this.#o.broker.listReceipts({ taskId: run.taskId });
    if (receipts.length === 0) return undefined;
    const task = await tasks.get(run.taskId);
    const evaluation = await evaluateTask(
      this.#o.provider,
      this.#o.evaluator?.model ?? this.#o.utilityModel ?? run.model,
      {
        goal: task?.goal ?? run.ownerText,
        receipts,
        // A tainted run's report may carry injected text; the receipts are the evidence.
        ...(run.taint ? {} : { finalReport: finalText }),
      },
      { signal: run.abort.signal },
    );
    this.#checkAbort(run);
    const gaps = evaluation.gaps.length === 0 ? "" : `: ${evaluation.gaps.join("; ")}`;
    this.#marker(
      run,
      `[evaluator: ${evaluation.verdict} after checking ${evaluation.receiptsChecked} receipt${evaluation.receiptsChecked === 1 ? "" : "s"}${gaps}]`,
    );
    return evaluation;
  }

  /**
   * The evaluator could not confirm the task: attended task runs ask the owner (the task parks
   * in `awaiting_input`); unattended runs fail so the owner is notified, never "done".
   */
  async #escalate(run: RunState, evaluation: Evaluation): Promise<RunOutcome> {
    if (run.mode === "attended" && run.taskId !== undefined && this.#o.tasks !== undefined) {
      const question: Question = {
        question: `I could not confirm this task is done. ${evaluation.reason}`.slice(0, 500),
        header: "Not verified",
        multiSelect: false,
        options: [
          { label: "Mark it done", description: "The receipts are enough; close the task" },
          { label: "Try again", description: "Work on the gaps the check found" },
          { label: "I'll handle it", description: "Stop here; leave the task to me" },
        ],
      };
      await this.#ask(run, [question]);
      return "awaiting_input";
    }
    throw new RunEnd("failed", `not_verified: ${evaluation.reason}`);
  }

  async #finishDecision(run: RunState, text: string): Promise<FinishTurnDecision> {
    if (this.#o.finishTurn === undefined) return "end";
    return this.#o.finishTurn({ threadId: run.threadId, runId: run.runId, text, steps: run.steps });
  }

  /** Unattended runs buffer text so `NO_REPLY` stays silent; emit it when the turn goes on. */
  #flushUnattended(run: RunState, text: string): void {
    if (run.mode !== "unattended" || text.trim() === "" || text.trim() === NO_REPLY) return;
    run.emit({ type: "chat.delta", runId: run.runId, messageId: run.messageId, delta: text });
  }

  #drainSteer(run: RunState): boolean {
    if (run.steer.length === 0) return false;
    for (const text of run.steer.splice(0)) {
      run.ownerText += `\n${text}`;
      run.thread.messages.push({ role: "user", parts: [{ type: "text", text }] });
    }
    return true;
  }

  #marker(run: RunState, text: string): void {
    run.emit({
      type: "block",
      runId: run.runId,
      messageId: run.messageId,
      block: { type: "text", md: text },
    });
  }

  #checkAbort(run: RunState): void {
    if (run.abort.signal.aborted) throw abortReason(run) ?? new RunEnd("cancelled");
  }

  #taint(run: RunState, source: TaintSource): void {
    run.taint = true;
    run.taintSources.push(source);
  }

  // --- Context ----------------------------------------------------------------------------------

  async #prepare(run: RunState): Promise<{ system: string; tools: ToolSpec[] }> {
    let built = await this.#assemble(run);
    const window = await this.#contextWindow(run.model);
    const estimate = estimateContextTokens(built.system, run.thread.messages, built.tools);
    if (estimate > window * this.#policy.thresholdRatio) {
      if (await this.#compact(run, estimate, window)) built = await this.#assemble(run);
    }
    this.#remember({
      runId: run.runId,
      threadId: run.threadId,
      model: run.model,
      permissionMode: run.permissionMode,
      system: built.system,
      sections: built.sections,
      tools: built.tools,
      messageCount: run.thread.messages.length,
      assembledAt: toIso(this.#clock.now()),
    });
    return built;
  }

  async #assemble(run: RunState): Promise<{
    system: string;
    sections: ContextSection[];
    tools: ToolSpec[];
  }> {
    const toggles = this.#o.toolToggles?.(run.threadId);
    let { tools, hidden } = this.registry.active({
      permissionMode: run.permissionMode,
      runMode: run.mode,
      subagent: run.subagent !== undefined,
      ...(toggles === undefined ? {} : { toggles }),
    });
    if (this.harnesses.list().length === 0) {
      // Offered only once a coding harness is installed (C10).
      tools = tools.filter((t) => t.spec.name !== "harness.delegate");
      hidden.set("harness.delegate", "no coding harness is installed");
    }
    const ctx = await assembleContext({
      basePrompt: this.#o.basePrompt ?? DEFAULT_BASE_PROMPT,
      ...(this.#o.memory === undefined ? {} : { memory: this.#o.memory }),
      ...(this.#o.skills === undefined ? {} : { skills: this.#o.skills }),
      tools: tools.map((t) => t.spec),
      permissionMode: run.permissionMode,
      runMode: run.mode,
      now: this.#clock.now(),
      timeZone: this.#o.timeZone ?? "UTC",
      ...(run.thread.summary === undefined ? {} : { summary: run.thread.summary }),
      budgets: this.#budgets,
    });
    if (ctx.untrusted && !run.taintSources.some((s) => s.sourceKind === "context")) {
      this.#taint(run, { sourceKind: "context" });
    }
    const sections = ctx.sections;
    for (const hook of this.hooks.handlers("before_prompt_build")) {
      const r = await hook({
        ...runRef(run),
        permissionMode: run.permissionMode,
        mode: run.mode,
        sections: structuredClone(sections),
        tools: tools.map((t) => structuredClone(t.spec)),
      });
      for (const s of r?.appendSections ?? []) sections.push({ ...s, kind: "hook" });
      if (r?.toolsAllow !== undefined) {
        const allow = new Set(r.toolsAllow);
        ({ tools, hidden } = this.registry.active({
          permissionMode: run.permissionMode,
          runMode: run.mode,
          subagent: run.subagent !== undefined,
          ...(toggles === undefined ? {} : { toggles }),
          allow: new Set(tools.map((t) => t.spec.name).filter((n) => allow.has(n))),
        }));
      }
    }
    run.active = new Map(tools.map((t) => [t.spec.name, t]));
    run.hidden = hidden;
    return {
      system: renderSystemPrompt(sections),
      sections,
      tools: tools.map((t) => structuredClone(t.spec)),
    };
  }

  #remember(e: ContextExplanation): void {
    this.#explanations.delete(e.runId);
    this.#explanations.set(e.runId, e);
    const limit = this.#o.explainHistory ?? 200;
    while (this.#explanations.size > limit) {
      const oldest = this.#explanations.keys().next().value;
      if (oldest === undefined) break;
      this.#explanations.delete(oldest);
    }
  }

  async #contextWindow(model: ModelRef): Promise<number> {
    let caps = this.#capabilities.get(model);
    if (caps === undefined) {
      caps = this.#o.provider.capabilities(model);
      this.#capabilities.set(model, caps);
    }
    try {
      return (await caps).contextWindow ?? this.#policy.defaultContextWindow;
    } catch {
      this.#capabilities.delete(model);
      return this.#policy.defaultContextWindow;
    }
  }

  /** B7: flush (private copy) → `before_compaction` → utility-model summary of older turns. */
  async #compact(run: RunState, estimate: number, window: number): Promise<boolean> {
    const { older, recent } = splitForCompaction(run.thread.messages, this.#policy.keepRecentTurns);
    if (older.length === 0) return false;
    const untrusted = containsUntrusted(older) || run.thread.summary?.untrusted === true;
    const signal = run.abort.signal;
    const memory = this.#o.memory;
    if (memory?.flush !== undefined && this.#o.isIncognito?.(run.threadId) !== true) {
      try {
        await memory.flush(run.threadId, structuredClone(run.thread.messages), {
          taint: run.taint || untrusted,
          signal,
        });
      } catch {
        // A failed flush must not wedge the thread; compaction still has to happen.
      }
    }
    for (const hook of this.hooks.handlers("before_compaction")) {
      await hook({
        ...runRef(run),
        messages: structuredClone(older),
        estimatedTokens: estimate,
        contextWindow: window,
      });
    }
    let text: string;
    try {
      text = await summarize(
        this.#o.provider,
        this.#o.utilityModel ?? run.model,
        run.thread.summary?.text,
        older,
        this.#policy,
        { signal },
      );
    } catch {
      this.#checkAbort(run);
      return false;
    }
    run.thread.summary = { text, untrusted };
    run.thread.messages = recent;
    return true;
  }

  // --- Model call -------------------------------------------------------------------------------

  async #callModel(
    run: RunState,
    system: string,
    tools: ToolSpec[],
  ): Promise<{
    parts: ModelPart[];
    text: string;
    calls: { id: string; name: string; input: unknown }[];
    finish: string;
    error?: string;
  }> {
    const parts: ModelPart[] = [];
    const calls: { id: string; name: string; input: unknown }[] = [];
    let text = "";
    let finish = "stop";
    let error: string | undefined;
    const request = {
      model: run.model,
      system,
      messages: run.thread.messages,
      ...(tools.length === 0 ? {} : { tools }),
    };
    // The thread lets the router apply its `/model` pin (strict) and attribute usage.
    const callOptions = { signal: run.abort.signal, threadId: run.threadId, runId: run.runId };
    for await (const ev of this.#o.provider.stream(request, callOptions)) {
      switch (ev.type) {
        case "text_delta": {
          text += ev.text;
          const last = parts.at(-1);
          if (last?.type === "text") last.text += ev.text;
          else parts.push({ type: "text", text: ev.text });
          if (run.mode === "attended") {
            run.emit({
              type: "chat.delta",
              runId: run.runId,
              messageId: run.messageId,
              delta: ev.text,
            });
          }
          break;
        }
        case "reasoning":
          // Provider-native and opaque: kept verbatim, never edited or re-ordered.
          parts.push({ type: "reasoning", provider: ev.provider, data: ev.data });
          break;
        case "tool_call":
          parts.push({ type: "tool_call", id: ev.id, name: ev.name, input: ev.input });
          calls.push({ id: ev.id, name: ev.name, input: ev.input });
          this.#toolEvent(run, ev.id, ev.name, "pending", `Calling ${ev.name}`);
          break;
        case "tool_result":
          // Provider-executed (server-side) tools fetch third-party content: untrusted.
          parts.push({
            type: "tool_result",
            callId: ev.callId,
            output: ev.output,
            ...(ev.isError === undefined ? {} : { isError: ev.isError }),
            provenance: "untrusted",
          });
          this.#taint(run, { sourceKind: "provider_tool", toolCallId: ev.callId });
          break;
        case "usage":
          run.usage = addUsage(run.usage, ev.usage);
          break;
        case "finish":
          finish = ev.reason;
          error = ev.error;
          break;
      }
    }
    return { parts, text, calls, finish, ...(error === undefined ? {} : { error }) };
  }

  // --- Tools ------------------------------------------------------------------------------------

  #toolEvent(
    run: RunState,
    toolCallId: string,
    tool: string,
    status: ToolCallStatus,
    level1: string,
    update?: ToolUpdate,
    details?: ToolCallDetails,
  ): void {
    run.emit({
      type: "tool_call",
      runId: run.runId,
      toolCallId,
      tool,
      status,
      level1,
      ...(update === undefined ? {} : { update }),
      ...(details === undefined ? {} : { details }),
    });
  }

  /**
   * What the Gateway persists in `tool_calls` (data model §2): the decision, the approval, the
   * taint in and out and the receipt. Sent with the call's final event so taint survives a
   * kill/restart on the stored row, not only in this process (design-07).
   */
  #details(g: Gated, provenanceOut: ProvenanceOut, receiptId?: string): ToolCallDetails {
    return {
      paramsRedacted: structuredClone(g.args),
      paramsHash: g.hash,
      sideEffect: g.sideEffect,
      target: g.target ?? null,
      decision: g.decision?.decision ?? null,
      decisionRule: g.decision?.rule ?? null,
      approvalId: g.approvalId ?? null,
      taintIn: g.taintIn,
      taintOut: provenanceOut === "untrusted",
      provenanceOut,
      receiptId: receiptId ?? null,
    };
  }

  /**
   * Gate and run the calls of one model response in order. Consecutive read-only calls run
   * concurrently once each has passed the broker; a steer, a cancel or a parked question skips
   * what is left (pi-agent-core: steering interrupts between tool calls).
   */
  async #runTools(
    run: RunState,
    calls: { id: string; name: string; input: unknown }[],
  ): Promise<ModelPart[]> {
    const results = new Map<string, ModelPart>();
    let i = 0;
    while (i < calls.length) {
      const stop = this.#interruption(run);
      if (stop !== undefined) {
        for (const c of calls.slice(i)) results.set(c.id, this.#skip(run, c, stop));
        break;
      }
      const first = calls[i] as (typeof calls)[number];
      const batch = [first];
      if (this.#readOnly(run, first)) {
        while (
          i + batch.length < calls.length &&
          this.#readOnly(run, calls[i + batch.length] as typeof first)
        ) {
          batch.push(calls[i + batch.length] as typeof first);
        }
      }
      const gated: Gated[] = [];
      for (const call of batch) {
        const outcome = await this.#gate(run, call);
        if ("done" in outcome) results.set(call.id, outcome.done);
        else gated.push(outcome.proceed);
      }
      const done = await Promise.all(gated.map((g) => this.#dispatch(run, g)));
      for (const [k, g] of gated.entries()) results.set(g.call.id, done[k] as ModelPart);
      i += batch.length;
    }
    return calls.map((c) => results.get(c.id) as ModelPart);
  }

  #readOnly(run: RunState, call: { name: string; input: unknown }): boolean {
    const reg = run.active.get(call.name);
    if (reg === undefined || INTERACTIVE.has(call.name)) return false;
    let described: SideEffect | undefined;
    try {
      described = reg.describeCall?.(call.input)?.sideEffect;
    } catch {
      return false;
    }
    return READ_ONLY.has(stricter(reg.spec.sideEffect, described));
  }

  #interruption(run: RunState): string | undefined {
    if (run.abort.signal.aborted) return "cancelled";
    if (run.parked !== undefined) return "not run: waiting for the owner's answer";
    if (run.steer.length > 0) return "skipped: the owner sent new guidance";
    return undefined;
  }

  #skip(run: RunState, call: { id: string; name: string }, why: string): ModelPart {
    this.#toolEvent(run, call.id, call.name, "blocked", why);
    return {
      type: "tool_result",
      callId: call.id,
      name: call.name,
      output: { error: why },
      isError: true,
      provenance: "trusted",
    };
  }

  #blocked(
    run: RunState,
    call: { id: string; name: string },
    message: string,
    status: ToolCallStatus = "blocked",
    gated?: Gated,
    errorCode?: string,
  ): GateOutcome {
    this.#toolEvent(
      run,
      call.id,
      call.name,
      status,
      message,
      undefined,
      gated === undefined ? undefined : this.#details(gated, "trusted"),
    );
    return {
      done: {
        type: "tool_result",
        callId: call.id,
        name: call.name,
        output: errorCode === undefined ? { error: message } : { error: message, errorCode },
        isError: true,
        provenance: "trusted",
      },
    };
  }

  /**
   * The binding of the call's arguments as they are now, when they differ from what was gated
   * (security §3.5, #70); `undefined` when unchanged. Uses the loop's own recipe, which differs
   * from any approved hash whenever the params hash does.
   */
  #changedBinding(g: Gated, kind: ApprovalKind | undefined): string | undefined {
    let live: unknown;
    let now: string;
    try {
      live = structuredClone(g.call.input);
      now = paramsHash(live);
    } catch {
      now = "unhashable";
    }
    if (now === g.hash) return undefined;
    let fields: unknown;
    try {
      fields = g.reg.describeCall?.(live)?.bindingFields;
    } catch {
      fields = undefined;
    }
    return bindingHash(kind ?? "connector_action", {
      tool: g.call.name,
      paramsHash: now,
      ...(fields === undefined ? {} : { fields }),
    });
  }

  /** `before_tool_call` hooks → `PermissionBroker.decide` → approval (security §3.3). */
  async #gate(
    run: RunState,
    call: { id: string; name: string; input: unknown },
    override?: AgentToolRegistration,
  ): Promise<GateOutcome> {
    const startedAt = toIso(this.#clock.now());
    const reg = override ?? run.active.get(call.name);
    if (reg === undefined) {
      const why = run.hidden.get(call.name);
      return this.#blocked(
        run,
        call,
        why === undefined ? `unknown tool ${call.name}` : `${call.name} is not available: ${why}`,
        why === undefined ? "failed" : "blocked",
      );
    }
    const invalid = reg.validate?.(call.input);
    if (invalid !== undefined)
      return this.#blocked(run, call, `invalid params: ${invalid}`, "failed");
    let desc: ToolCallDescription = {};
    try {
      desc = reg.describeCall?.(call.input) ?? {};
    } catch (err) {
      return this.#blocked(run, call, `invalid params: ${errorMessage(err)}`, "failed");
    }
    const sideEffect = stricter(reg.spec.sideEffect, desc.sideEffect);
    const target = desc.target;
    // Freeze the arguments before hashing (#70): nobody else holds a reference to this copy.
    const args = structuredClone(call.input);
    const hash = paramsHash(args);
    const taintIn = run.taint;
    const gated: Gated = {
      call,
      reg,
      desc,
      sideEffect,
      ...(target === undefined ? {} : { target }),
      args,
      hash,
      taintIn,
      startedAt,
    };

    for (const hook of this.hooks.handlers("before_tool_call")) {
      let r: Awaited<ReturnType<typeof hook>>;
      try {
        r = await hook({
          ...runRef(run),
          toolCallId: call.id,
          tool: call.name,
          params: structuredClone(args),
          spec: structuredClone(reg.spec),
          taint: run.taint,
          permissionMode: run.permissionMode,
          mode: run.mode,
        });
      } catch (err) {
        return this.#finishBlocked(run, gated, `blocked by a hook (error: ${errorMessage(err)})`);
      }
      if (r === undefined || r.action === "continue") continue;
      if (r.action === "block") return this.#finishBlocked(run, gated, `blocked: ${r.reason}`);
      if (run.subagent !== undefined) {
        return this.#finishBlocked(run, gated, NO_APPROVAL_AUTHORITY);
      }
      if (run.mode === "unattended") {
        // Nobody is there to answer: the hook's request stays queued (C8).
        return this.#finishBlocked(run, gated, `deferred: hook approval ${r.approvalId} queued`);
      }
      const approval = await this.#await(run, r.approvalId, call);
      if (approval !== "approved")
        return this.#finishBlocked(run, gated, `blocked: hook approval ${approval}`);
    }

    this.#checkAbort(run);
    const kind = desc.kind;
    if (kind === "memory_protected_write" && run.taint) {
      // Untrusted-derived writes never reach protected memory (security §3.6, §8): no card.
      return this.#finishBlocked(
        run,
        gated,
        "denied: a turn that read untrusted content cannot change protected memory",
      );
    }
    // The binding always covers the tool and every argument, plus the kind's own fields
    // (security §3.5); a third-party description can add precision, never drop arguments.
    const intentBinding =
      kind === undefined
        ? undefined
        : bindingHash(kind, {
            tool: call.name,
            paramsHash: hash,
            ...(desc.bindingFields === undefined ? {} : { fields: desc.bindingFields }),
          });
    // Grant keys are namespaced by tool so a description cannot borrow another tool's grants.
    const grantKey =
      desc.grantKey === undefined ? undefined : namespacedGrantKey(call.name, desc.grantKey);
    const context = this.#decisionContext(run, target, sideEffect);
    const decision = await this.#o.broker.decide(
      {
        tool: call.name,
        sideEffect,
        ...((target?.kind ?? reg.spec.targetKind)
          ? { targetKind: target?.kind ?? reg.spec.targetKind }
          : {}),
        ...(target === undefined ? {} : { target }),
        params: structuredClone(args),
        paramsHash: hash,
        ...(kind === undefined ? {} : { kind }),
        ...(intentBinding === undefined ? {} : { bindingHash: intentBinding }),
        ...(grantKey === undefined ? {} : { grantKey }),
      },
      context,
    );
    this.#checkAbort(run);
    gated.decision = decision;
    if (decision.decision === "deny") {
      return this.#finishBlocked(run, gated, `denied: ${decision.reason ?? decision.rule}`);
    }
    if (decision.decision === "ask" && run.subagent !== undefined) {
      // Subagents have no approval authority (C6): the parent decides whether to ask.
      return this.#finishBlocked(run, gated, NO_APPROVAL_AUTHORITY);
    }
    if (decision.decision === "allow") {
      const binding =
        decision.bindingHash ??
        intentBinding ??
        bindingHash(kind ?? "connector_action", { tool: call.name, paramsHash: hash });
      const authority: ToolCallAuthority = {
        rule: decision.rule,
        bindingHash: binding,
        ...(grantKey === undefined ? {} : { grantKey }),
      };
      if (decision.grantId !== undefined) {
        // A standing grant allowed the call: confirm it is still live right before dispatch
        // (security §3.4, §3.7 "Dispatch"), the way `verifyBinding` does for an approval.
        const grant = await this.#liveGrant(decision.grantId);
        this.#checkAbort(run);
        if (grant === undefined) {
          return this.#finishBlocked(
            run,
            gated,
            `grant check failed (grant ${decision.grantId} is not live)`,
          );
        }
        authority.grantId = grant.id;
        authority.scope = grant.scope;
        if (authority.grantKey === undefined) authority.grantKey = grant.grantKey;
      }
      gated.authority = authority;
    }
    if (decision.decision === "ask") {
      const approvalKind = decision.approvalKind ?? kind ?? "connector_action";
      gated.approvalKind = approvalKind;
      const binding =
        decision.bindingHash ??
        intentBinding ??
        bindingHash(approvalKind, { tool: call.name, paramsHash: hash });
      const issued = await this.#o.broker.requestApproval({
        context,
        kind: approvalKind,
        summary: desc.summary ?? `${call.name}`,
        details: {
          ...desc.details,
          tool: call.name,
          params: structuredClone(args) as unknown,
          ...(target === undefined ? {} : { target }),
        },
        bindingHash: binding,
        grantKey: decision.grantKey ?? grantKey ?? `${call.name}|${target?.value ?? "*"}`,
        requestedBy: {
          runId: run.runId,
          taskId: run.taskId ?? null,
          threadId: run.threadId,
          toolCallId: call.id,
        },
        sideEffect,
        ...((target?.kind ?? reg.spec.targetKind)
          ? { targetKind: target?.kind ?? reg.spec.targetKind }
          : {}),
        ...(target === undefined ? {} : { target }),
        surfaces: this.#o.approvalSurfaces ?? ["desktop"],
        // Protected memory "always asks" (security §8): no standing grant may cover it.
        ...(approvalKind === "memory_protected_write"
          ? { scopesOffered: ["once" as const] }
          : decision.scopesOffered === undefined
            ? {}
            : { scopesOffered: decision.scopesOffered }),
        taint: run.taint,
      });
      const approvalId = issued.approval.id;
      gated.approvalId = approvalId;
      run.emit({ type: "approval_requested", runId: run.runId, approval: issued.approval });
      this.#block(run, { type: "approval", approvalId });
      if (run.mode === "unattended") {
        // C8: no attempt; the request waits in the queue and the owner is notified.
        await this.#o.notifier
          ?.notify({
            kind: "approval",
            title: `Approval needed: ${issued.approval.summary}`,
            body: `An unattended run wants to ${issued.approval.summary}.`,
            approvalId,
            ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
          })
          .catch(() => undefined);
        const note = "deferred: queued for the owner's approval; continue without this action";
        this.#toolEvent(
          run,
          call.id,
          call.name,
          "blocked",
          note,
          undefined,
          this.#details(gated, "trusted"),
        );
        const part: ModelPart = {
          type: "tool_result",
          callId: call.id,
          name: call.name,
          output: { deferred: true, approvalId, note },
          isError: true,
          provenance: "trusted",
        };
        await this.#persist(run, gated, "blocked", part, undefined);
        return { done: part };
      }
      const answer = await this.#await(run, approvalId, call);
      if (answer !== "approved") return this.#finishBlocked(run, gated, `not approved (${answer})`);
      // Recompute from the call's arguments as they are now (security §3.5): a change while the
      // card was open reaches the broker as a different hash, which denies and audits it.
      const changed = this.#changedBinding(gated, approvalKind);
      const verified = await this.#o.broker.verifyBinding(approvalId, changed ?? binding);
      this.#checkAbort(run);
      if (!verified.ok || changed !== undefined) {
        const reason = verified.ok ? "binding_mismatch" : verified.reason;
        return this.#finishBlocked(run, gated, `approval check failed (${reason})`, reason);
      }
      // Only targets the owner approved count as known for later calls (security §3.6).
      if (target !== undefined && target.value !== "") run.targets.add(target.value);
      gated.authority = {
        rule: `approval:${approvalId}`,
        bindingHash: binding,
        grantKey: verified.approval.grantKey,
        approvalId,
        ...(verified.approval.grantId == null ? {} : { grantId: verified.approval.grantId }),
        ...(verified.approval.scopeGranted == null
          ? {}
          : { scope: verified.approval.scopeGranted }),
      };
    }
    return { proceed: gated };
  }

  /** The broker's view of the run for `decide` and the card (security §3.6, §9). */
  #decisionContext(run: RunState, target: Target | undefined, sideEffect: SideEffect) {
    return {
      threadId: run.threadId,
      runId: run.runId,
      ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
      permissionMode: run.permissionMode,
      taint: run.taint,
      ...(run.taint ? { taintSources: dedupeSources(run.taintSources) } : {}),
      newTarget: this.#isNewTarget(run, target, sideEffect),
      unattended: run.mode === "unattended",
      ...(run.requester === undefined ? {} : { requester: structuredClone(run.requester) }),
    };
  }

  /** A standing grant as the ledger has it now, or `undefined` when revoked, expired or gone. */
  async #liveGrant(grantId: string) {
    const grant = (await this.#o.broker.listGrants()).find((g) => g.id === grantId);
    if (grant === undefined || grant.revokedAt != null) return undefined;
    if (grant.expiresAt != null && Date.parse(grant.expiresAt) <= this.#clock.now()) {
      return undefined;
    }
    return grant;
  }

  /**
   * New relative to the owner's words and earlier approvals in this run (security §3.6): an
   * exact match of the canonical target against what the owner typed, never a substring and
   * never the executor-supplied `display`. A write+ call without a target is new (fail closed).
   */
  #isNewTarget(run: RunState, target: Target | undefined, sideEffect: SideEffect): boolean {
    if (target === undefined || target.value.trim() === "") {
      return SEVERITY[sideEffect] >= SEVERITY.write;
    }
    const value = target.value.trim().toLowerCase();
    if (run.targets.has(target.value)) return false;
    return !ownerTargets(run.ownerText).has(value);
  }

  /** Park the run on an approval (attended). Returns the final status. */
  async #await(
    run: RunState,
    approvalId: string,
    call: { id: string; name: string },
  ): Promise<string> {
    run.emit({ type: "run.status", runId: run.runId, status: "awaiting_approval" });
    this.#toolEvent(run, call.id, call.name, "pending", "Waiting for approval");
    try {
      const a = await this.#o.broker.awaitDecision(approvalId, run.abort.signal);
      return a.status;
    } catch (err) {
      this.#checkAbort(run);
      throw err;
    } finally {
      if (!run.abort.signal.aborted)
        run.emit({ type: "run.status", runId: run.runId, status: "running" });
    }
  }

  async #finishBlocked(
    run: RunState,
    gated: Gated,
    message: string,
    errorCode?: string,
  ): Promise<GateOutcome> {
    const outcome = this.#blocked(run, gated.call, message, "blocked", gated, errorCode);
    await this.#persist(run, gated, "blocked", (outcome as { done: ModelPart }).done, undefined);
    return outcome;
  }

  #block(run: RunState, block: Block): void {
    run.emit({ type: "block", runId: run.runId, messageId: run.messageId, block });
  }

  async #dispatch(run: RunState, g: Gated): Promise<ModelPart> {
    this.#checkAbort(run);
    const { call, reg } = g;
    const changed = this.#changedBinding(g, g.approvalKind ?? g.desc.kind);
    if (changed !== undefined) {
      // Last check immediately before dispatch (security §3.5): audit through the broker.
      if (g.approvalId !== undefined)
        await this.#o.broker.verifyBinding(g.approvalId, changed).catch(() => undefined);
      const outcome = await this.#finishBlocked(
        run,
        g,
        "approval check failed (binding_mismatch): arguments changed after the decision",
        "binding_mismatch",
      );
      return (outcome as { done: ModelPart }).done;
    }
    // The executor gets its own copy of the gated arguments; its mutations stay its own.
    const args = structuredClone(g.args);
    const level1 = g.desc.summary ?? call.name;
    this.#toolEvent(run, call.id, call.name, "running", level1);
    const ctx: TurnToolContext = {
      callId: call.id,
      threadId: run.threadId,
      runId: run.runId,
      ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
      taint: run.taint,
      taintSources: dedupeSources(run.taintSources),
      permissionMode: run.permissionMode,
      mode: run.mode,
      ...(g.approvalId === undefined ? {} : { approvalId: g.approvalId }),
      ...(g.authority === undefined ? {} : { authority: structuredClone(g.authority) }),
      ...(run.requester === undefined ? {} : { requester: structuredClone(run.requester) }),
      signal: run.abort.signal,
      onUpdate: (update) => this.#toolEvent(run, call.id, call.name, "running", level1, update),
      turn: this.#turnApi(run, call.id),
    };
    let result: ToolResult;
    try {
      result =
        reg.run !== undefined
          ? await reg.run(args, ctx)
          : await reg.execute(call.id, args, run.abort.signal, ctx.onUpdate);
    } catch (err) {
      if (err instanceof RunEnd) throw err;
      if (run.abort.signal.aborted) throw abortReason(run) ?? new RunEnd("cancelled");
      // An external executor's error text may quote third-party content.
      result = {
        output: { error: errorMessage(err) },
        isError: true,
        provenance: reg.run === undefined ? "untrusted" : reg.spec.provenanceOut,
      };
    }
    result = { ...result, provenance: worst(reg.spec.provenanceOut, result.provenance) };
    for (const hook of this.hooks.handlers("after_tool_call")) {
      const r = await hook({
        ...runRef(run),
        toolCallId: call.id,
        tool: call.name,
        params: structuredClone(g.args),
        spec: structuredClone(reg.spec),
        taint: run.taint,
        permissionMode: run.permissionMode,
        mode: run.mode,
        result: structuredClone(result),
      });
      // A hook may mask a result; it can never make it more trusted.
      if (r?.result !== undefined)
        result = { ...r.result, provenance: worst(result.provenance, r.result.provenance) };
    }
    if (result.provenance === "untrusted") {
      this.#taint(run, {
        sourceKind: call.name,
        toolCallId: call.id,
        ...(g.target === undefined ? {} : { origin: g.target.value }),
      });
    }
    const failed = result.isError === true;
    if (SEVERITY[g.sideEffect] >= SEVERITY.write && result.receiptId === undefined) {
      // Every side-effecting action gets a receipt (security rules; architecture §4.2 step 4).
      const receipt = await this.#o.broker.recordReceipt({
        kind: g.approvalKind ?? g.desc.kind ?? call.name,
        outcome: failed ? "failed" : "ok",
        summary: level1,
        taskId: run.taskId ?? null,
        toolCallId: call.id,
        approvalId: g.approvalId ?? null,
      });
      result = { ...result, receiptId: receipt.id };
    }
    if (result.receiptId !== undefined)
      this.#block(run, { type: "receipt", receiptId: result.receiptId });
    const status: ToolCallStatus = failed ? "failed" : "ok";
    this.#toolEvent(
      run,
      call.id,
      call.name,
      status,
      level1,
      undefined,
      this.#details(g, result.provenance, result.receiptId),
    );
    const part: ModelPart = {
      type: "tool_result",
      callId: call.id,
      name: call.name,
      output: this.#cap(result.output),
      ...(failed ? { isError: true } : {}),
      provenance: result.provenance,
    };
    await this.#persist(run, g, status, part, result);
    return part;
  }

  /** Oversized results are cut with a visible marker, never silently (C2). */
  #cap(output: unknown): unknown {
    const max = this.#o.maxToolResultChars ?? 50_000;
    const text = typeof output === "string" ? output : JSON.stringify(output ?? null);
    if (text.length <= max) return output;
    return `${text.slice(0, max)}\n[truncated: result is ${text.length.toLocaleString("en-US")} characters; the first ${max.toLocaleString("en-US")} are shown]`;
  }

  async #persist(
    run: RunState,
    g: Gated,
    status: ToolCallStatus,
    part: ModelPart,
    result: ToolResult | undefined,
  ): Promise<void> {
    const handlers = this.hooks.handlers("tool_result_persist");
    if (handlers.length === 0) return;
    const provenance: ProvenanceOut =
      part.type === "tool_result" ? (part.provenance ?? "trusted") : "trusted";
    const record: ToolCall = {
      id: g.call.id,
      runId: run.runId,
      messageId: run.messageId,
      tool: g.call.name,
      paramsRedacted: structuredClone(g.args),
      paramsHash: g.hash,
      sideEffect: g.sideEffect,
      target: g.target ?? null,
      decision: g.decision?.decision ?? null,
      decisionRule: g.decision?.rule ?? null,
      approvalId: g.approvalId ?? null,
      taintIn: g.taintIn,
      taintOut: provenance === "untrusted",
      resultRef: null,
      provenanceOut: provenance,
      receiptId: result?.receiptId ?? null,
      startedAt: g.startedAt,
      endedAt: toIso(this.#clock.now()),
      status,
    };
    const persisted: ToolResult = result ?? {
      output: part.type === "tool_result" ? part.output : null,
      isError: true,
      provenance,
    };
    for (const hook of handlers) await hook({ record, result: structuredClone(persisted) });
  }

  // --- Turn tools -------------------------------------------------------------------------------

  #turnApi(run: RunState, toolCallId: string): TurnApi {
    return {
      emitBlock: (block) => this.#block(run, block),
      checklist: () => structuredClone(run.thread.checklist),
      setChecklist: (items) => {
        run.thread.checklist = structuredClone(items);
      },
      ask: (questions) => this.#ask(run, questions),
      spawnSubagent: (input) => this.#spawn(run, toolCallId, input),
      gateHarnessAction: (harnessId, callId, action) =>
        this.#gateHarness(run, harnessId, callId, action),
      harnessActionDone: (actionId, outcome, summary) =>
        this.#harnessDone(run, actionId, outcome, summary),
      exitPlan: (plan) => this.#exitPlan(run, toolCallId, plan),
    };
  }

  async #ask(
    run: RunState,
    questions: Question[],
  ): Promise<{ answer: QuestionAnswer } | { parked: InputRequest }> {
    if (run.mode === "unattended" || run.subagent !== undefined) {
      throw new PsycheError("forbidden", "ask_user is not available in this run");
    }
    if (run.taskId !== undefined && this.#o.tasks !== undefined) {
      // Background run: the task parks in awaiting_input; the answer re-queues it (§4.5).
      const request = await this.#o.tasks.requestInput(run.taskId, questions);
      run.parked = request;
      run.emit({ type: "question", runId: run.runId, inputRequest: request });
      this.#block(run, { type: "question", inputRequestId: request.id });
      return { parked: request };
    }
    const request: InputRequest = {
      id: this.#ids.next("inp"),
      taskId: null,
      threadId: run.threadId,
      questions,
      status: "open",
      answer: null,
      createdAt: toIso(this.#clock.now()),
      answeredAt: null,
      answeredByDeviceId: null,
    };
    const wait = deferred<QuestionAnswer>();
    run.questions.set(request.id, { request, resolve: wait.resolve, reject: wait.reject });
    run.emit({ type: "question", runId: run.runId, inputRequest: structuredClone(request) });
    this.#block(run, { type: "question", inputRequestId: request.id });
    run.emit({ type: "run.status", runId: run.runId, status: "awaiting_input" });
    const answer = await wait.promise;
    run.emit({ type: "run.status", runId: run.runId, status: "running" });
    return { answer };
  }

  /**
   * C6: run a subagent to completion as a child run of this loop. `fork` copies the transcript
   * (without the unanswered calls of the current step), `fresh` starts from the brief. The
   * child inherits the parent's taint, model, mode and broker; its tokens count toward the
   * parent; cancelling the parent cancels it.
   */
  async #spawn(
    parent: RunState,
    toolCallId: string,
    input: SpawnSubagentInput,
  ): Promise<SubagentResult> {
    if (parent.subagent !== undefined) {
      throw new PsycheError("forbidden", "subagents cannot spawn subagents");
    }
    const limit = this.#o.maxConcurrentSubagents ?? 4;
    if (parent.children >= limit) {
      throw new PsycheError("rate_limited", `at most ${limit} subagents at once`);
    }
    const id = this.#ids.next("sub");
    const threadId = `${parent.threadId}:sub:${id}`;
    const runId = `${parent.runId}:sub:${id}`;
    const info: SubagentInfo = {
      id,
      parentRunId: parent.runId,
      parentThreadId: parent.threadId,
      threadId,
      runId,
      context: input.context,
      title: input.title,
      status: "running",
    };
    this.#subagents.set(id, info);
    const messages =
      input.context === "fork" ? answeredPrefix(structuredClone(parent.thread.messages)) : [];
    const brief = `You are a subagent working for the agent of this conversation. Task: ${input.title}\n\n${input.brief}\n\nWork on your own: you cannot ask the owner questions, send messages or request approvals. Finish with a concise report of what you found or did; that report is all the parent sees.`;
    const update = (message: string) =>
      this.#toolEvent(parent, toolCallId, "subagent.spawn", "running", `Subagent: ${input.title}`, {
        message,
      });
    let steps = 0;
    parent.children += 1;
    let child: RunState | undefined;
    try {
      child = await this.#execute(
        {
          threadId,
          runId,
          ...(parent.taskId === undefined ? {} : { taskId: parent.taskId }),
          input: { text: brief },
          mode: parent.mode,
          permissionMode: parent.permissionMode,
          signal: parent.abort.signal,
        },
        (event) => {
          if (
            event.type === "tool_call" &&
            event.status === "running" &&
            event.update === undefined
          ) {
            steps += 1;
            update(`${event.level1 ?? event.tool}`);
          }
          if (event.type === "end")
            info.status =
              event.outcome === "final"
                ? "final"
                : event.outcome === "cancelled"
                  ? "cancelled"
                  : "failed";
          this.#o.onSubagentEvent?.({ ...info }, event);
        },
        {
          parent,
          messages,
          ...(input.context === "fork" && parent.thread.summary !== undefined
            ? { summary: structuredClone(parent.thread.summary) }
            : {}),
          maxSteps: this.#o.subagentMaxSteps ?? 20,
        },
      );
    } finally {
      parent.children -= 1;
    }
    if (child === undefined) throw new PsycheError("conflict", "subagent could not start");
    parent.usage = addUsage(parent.usage, child.usage);
    // The subagent's taint carries into the parent (architecture §4.3).
    if (child.taint) this.#taint(parent, { sourceKind: "subagent", toolCallId });
    if (info.status === "running") info.status = "failed";
    const result = lastAssistantText(child.thread.messages);
    return {
      subagentId: id,
      threadId,
      outcome: info.status,
      result: result === "" ? "(the subagent produced no report)" : result,
      tainted: child.taint,
      steps,
    };
  }

  /**
   * C10: one action of an embedded harness, gated exactly like a native call named
   * `harness__<id>__<tool>`: hooks, broker, approval card, binding check. The session is
   * treated as tainted (the harness reads repository files and the web).
   */
  async #gateHarness(
    run: RunState,
    harnessId: string,
    callId: string,
    action: HarnessAction,
  ): Promise<HarnessGateResult> {
    run.harnessActions += 1;
    const actionId = `${callId}:${run.harnessActions}`;
    if (!run.taintSources.some((s) => s.sourceKind === "harness")) {
      this.#taint(run, { sourceKind: "harness", toolCallId: callId });
    }
    const name = `harness__${harnessId}__${action.tool}`.slice(0, 128);
    const reg: AgentToolRegistration = {
      spec: {
        name,
        description: `${harnessId} ${action.tool}`,
        inputSchema: { type: "object" },
        sideEffect: action.sideEffect,
        provenanceOut: "untrusted",
        ...(action.targetKind === undefined ? {} : { targetKind: action.targetKind }),
      },
      execute: () =>
        Promise.reject(new PsycheError("internal", "harness actions run in the harness")),
      describeCall: () => ({
        summary: action.summary,
        ...(action.target === undefined ? {} : { target: action.target }),
      }),
    };
    this.#toolEvent(run, actionId, name, "pending", action.summary);
    const outcome = await this.#gate(run, { id: actionId, name, input: action.input }, reg);
    if ("done" in outcome) {
      const part = outcome.done;
      const output = part.type === "tool_result" ? (part.output as { error?: string }) : {};
      return { allowed: false, actionId, reason: output.error ?? "not allowed" };
    }
    run.harnessPending.set(actionId, outcome.proceed);
    this.#toolEvent(run, actionId, name, "running", action.summary);
    return {
      allowed: true,
      actionId,
      ...(outcome.proceed.approvalId === undefined
        ? {}
        : { approvalId: outcome.proceed.approvalId }),
    };
  }

  async #harnessDone(
    run: RunState,
    actionId: string,
    outcome: "ok" | "failed" | "uncertain",
    summary?: string,
  ): Promise<void> {
    const g = run.harnessPending.get(actionId);
    if (g === undefined)
      throw new PsycheError("not_found", `no allowed harness action ${actionId}`);
    run.harnessPending.delete(actionId);
    const level1 = summary ?? g.desc.summary ?? g.call.name;
    let receiptId: string | undefined;
    if (SEVERITY[g.sideEffect] >= SEVERITY.write) {
      const receipt = await this.#o.broker.recordReceipt({
        kind: g.approvalKind ?? g.call.name,
        outcome,
        summary: level1,
        taskId: run.taskId ?? null,
        toolCallId: actionId,
        approvalId: g.approvalId ?? null,
      });
      receiptId = receipt.id;
      this.#block(run, { type: "receipt", receiptId });
    }
    const status: ToolCallStatus =
      outcome === "ok" ? "ok" : outcome === "failed" ? "failed" : "uncertain";
    this.#toolEvent(run, actionId, g.call.name, status, level1);
    const result: ToolResult = {
      output: { outcome, summary: level1 },
      ...(outcome === "ok" ? {} : { isError: true }),
      provenance: "untrusted",
      ...(receiptId === undefined ? {} : { receiptId }),
    };
    await this.#persist(
      run,
      g,
      status,
      {
        type: "tool_result",
        callId: actionId,
        name: g.call.name,
        output: result.output,
        provenance: "untrusted",
      },
      result,
    );
  }

  /** Subagents of a thread (or all), newest last, for the Subagents pane (C6). */
  subagents(parentThreadId?: string): SubagentInfo[] {
    return [...this.#subagents.values()]
      .filter((s) => parentThreadId === undefined || s.parentThreadId === parentThreadId)
      .map((s) => ({ ...s }));
  }

  async #exitPlan(
    run: RunState,
    toolCallId: string,
    plan: { title: string; plan: string },
  ): Promise<{ planId: string; approved: boolean; reason?: string }> {
    if (run.permissionMode !== "plan") {
      throw new PsycheError("invalid_params", "exit_plan_mode is only available in plan mode");
    }
    const planId = this.#ids.next("plan");
    this.#plans.set(planId, { threadId: run.threadId, ...plan });
    this.#block(run, { type: "plan", planId });
    const binding = bindingHash("plan_exit", { planId, planHash: sha256(plan.plan) });
    const issued = await this.#o.broker.requestApproval({
      context: this.#decisionContext(run, undefined, "write"),
      kind: "plan_exit",
      summary: `Approve plan: ${plan.title}`,
      details: { planId, title: plan.title, plan: plan.plan },
      bindingHash: binding,
      grantKey: `plan_exit|${run.threadId}`,
      requestedBy: {
        runId: run.runId,
        taskId: run.taskId ?? null,
        threadId: run.threadId,
        toolCallId,
      },
      sideEffect: "write",
      surfaces: this.#o.approvalSurfaces ?? ["desktop"],
      scopesOffered: ["once"],
      taint: run.taint,
    });
    run.emit({ type: "approval_requested", runId: run.runId, approval: issued.approval });
    this.#block(run, { type: "approval", approvalId: issued.approval.id });
    const status = await this.#await(run, issued.approval.id, {
      id: toolCallId,
      name: "exit_plan_mode",
    });
    if (status !== "approved") return { planId, approved: false, reason: status };
    const verified = await this.#o.broker.verifyBinding(issued.approval.id, binding);
    if (!verified.ok) return { planId, approved: false, reason: verified.reason };
    const next = this.#o.planExitMode ?? "balanced";
    run.permissionMode = next;
    this.#o.onPermissionModeChange?.(run.threadId, next);
    return { planId, approved: true };
  }
}

function runRef(run: RunState) {
  return {
    threadId: run.threadId,
    runId: run.runId,
    ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
  };
}

function abortReason(run: RunState): RunEnd | undefined {
  if (!run.abort.signal.aborted) return undefined;
  const reason: unknown = run.abort.signal.reason;
  return reason instanceof RunEnd ? reason : new RunEnd("cancelled");
}

/**
 * Canonical targets the owner named: e-mail addresses, URLs (and their origins), hosts and
 * absolute paths, as whole tokens.
 */
export function ownerTargets(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[\s,;<>()"'`[\]{}]+/)) {
    const token = raw.replace(/[.:!?]+$/, "").toLowerCase();
    if (token === "") continue;
    out.add(token);
    const email = /^mailto:(.+)$/.exec(token);
    if (email?.[1] !== undefined) out.add(email[1]);
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(token) ? token : `https://${token}`);
      if (url.hostname.includes(".")) {
        out.add(url.origin);
        out.add(url.hostname);
      }
    } catch {
      // not a URL
    }
  }
  return out;
}

function worst(a: ProvenanceOut, b: ProvenanceOut | undefined): ProvenanceOut {
  return a === "untrusted" || b === "untrusted" ? "untrusted" : "trusted";
}

function userText(input: StartTurnInput): string {
  const files = input.input.attachments ?? [];
  if (files.length === 0) return input.input.text;
  return `${input.input.text}\n\n[attached library items: ${files.map((f) => f.libraryItemId).join(", ")}]`;
}

/** The transcript up to the last message whose tool calls all have results. */
function reopenMessage(e: Evaluation): string {
  return [
    "[evaluator] The receipts do not show this task is done yet. Address these gaps, then report again:",
    ...e.gaps.map((g) => `- ${g}`),
    e.reason === "" ? "" : `Reason: ${e.reason}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function answeredPrefix(messages: ModelMessage[]): ModelMessage[] {
  const answered = new Set<string>();
  for (const m of messages)
    for (const p of m.parts) if (p.type === "tool_result") answered.add(p.callId);
  let end = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as ModelMessage;
    if (m.parts.some((p) => p.type === "tool_call" && !answered.has(p.id))) end = i;
  }
  return messages.slice(0, end);
}

function lastAssistantText(messages: readonly ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as ModelMessage;
    if (m.role !== "assistant") continue;
    const text = m.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim();
    if (text !== "") return text;
  }
  return "";
}

/** Every tool call in the transcript keeps a result, so the next turn is a valid request. */
function closeDanglingCalls(messages: ModelMessage[], why: string): void {
  const answered = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts) if (p.type === "tool_result") answered.add(p.callId);
  }
  const missing: ModelPart[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts) {
      if (p.type === "tool_call" && !answered.has(p.id)) {
        missing.push({
          type: "tool_result",
          callId: p.id,
          name: p.name,
          output: { error: why },
          isError: true,
          provenance: "trusted",
        });
      }
    }
  }
  if (missing.length > 0) messages.push({ role: "tool", parts: missing });
}

export function createAgentLoop(options: AgentLoopOptions): PsycheAgentLoop {
  return new PsycheAgentLoop(options);
}
