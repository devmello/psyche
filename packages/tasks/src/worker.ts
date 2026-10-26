import type {
  AgentEvent,
  AgentLoop,
  ApprovalRequest,
  ClaimOptions,
  Clock,
  InputRequest,
  IssuedApproval,
  JsonObject,
  Notifier,
  PermissionBroker,
  PermissionMode,
  RunOutcome,
  SideEffect,
  Task,
  TaskCheckpoint,
  TaskLease,
  ToolCallStatus,
  ToolRegistry,
  TurnInput,
} from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import type { SqliteTaskEngine } from "./engine.ts";
import type { ResumeItem, TaskBudget, TaskRecord } from "./types.ts";

/** Host timers; tests pass one driven by `FakeClock`. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimers: Timers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface TaskWorkerPoolOptions {
  engine: SqliteTaskEngine;
  loop: AgentLoop;
  clock: Clock;
  timers?: Timers;
  /** Lease owner prefix; slot `n` claims as `<owner>/<n>`. */
  owner?: string;
  /** Turns running at once (M1: one Gateway process). */
  concurrency?: number;
  leaseMs?: number;
  /** Lease renewal period; default a third of `leaseMs`. */
  renewEveryMs?: number;
  /** How often idle slots look for queued work; `poke()` wakes them sooner. */
  pollMs?: number;
  broker?: PermissionBroker;
  notifier?: Notifier;
  /** Tool metadata; a tool is replay-safe when its side effect is `none` or `read`. */
  tools?: ToolRegistry;
  /** Overrides `tools`; unknown tools are treated as unsafe. */
  isReplaySafe?: (tool: string) => boolean;
  permissionModeFor?: (task: Task) => PermissionMode | Promise<PermissionMode>;
  newRunId?: () => string;
  /** Applied when a task has no budget of its own. */
  defaultBudget?: TaskBudget;
  /**
   * Which tasks this pool claims (docs/agent/specialists-2026.md §4.5): the specialist pool
   * claims only `subagent` jobs, at most `perParentLimit` per parent thread; the chat pool
   * excludes them.
   */
  claim?: Pick<ClaimOptions, "origins" | "excludeOrigins" | "perParentLimit">;
  onError?: (error: unknown) => void;
}

export interface TurnReport {
  taskId: string;
  runId: string;
  outcome: RunOutcome | "lease_lost" | "budget_exceeded" | "stopped";
  task: Task | undefined;
}

interface ActiveTurn {
  runId: string;
  controller: AbortController;
  stop: (reason: "cancelled" | "paused" | "lease_lost") => void;
}

const SAFE_EFFECTS: readonly SideEffect[] = ["none", "read"];
const CHECKPOINT_STATUS: Partial<Record<ToolCallStatus, TaskCheckpoint["status"]>> = {
  running: "running",
  ok: "done",
  failed: "failed",
  blocked: "failed",
  uncertain: "uncertain",
};
const SUMMARY_MAX = 2_000;

/** What the next turn of a task is told (goal on the first attempt, then what changed). */
export function buildTurnInput(
  record: TaskRecord,
  resume: ResumeItem[],
  checkpoints: TaskCheckpoint[],
): TurnInput {
  const { task } = record;
  const lines: string[] = [];
  const firstTurn = checkpoints.length === 0 && resume.length === 0;
  if (firstTurn) {
    lines.push(`Task: ${task.title}`, "", task.goal);
  } else {
    lines.push(`Continue task: ${task.title}`, "", `Goal: ${task.goal}`);
    const done = checkpoints.filter((c) => c.status === "done").map((c) => c.stepId);
    if (done.length > 0) lines.push(`Completed steps: ${done.join(", ")}`);
  }
  const uncertain = checkpoints.filter((c) => c.status === "uncertain").map((c) => c.stepId);
  if (uncertain.length > 0) {
    lines.push(
      `Uncertain steps (interrupted mid-flight; do NOT repeat them, check their outcome first): ${uncertain.join(", ")}`,
    );
  }
  for (const item of resume) {
    switch (item.kind) {
      case "input_answered":
        lines.push(`The user answered: ${JSON.stringify(item.answer)}`);
        break;
      case "approval":
        lines.push(
          item.status === "approved"
            ? `Approval ${item.approvalId} was granted; retry the approved action.`
            : `Approval ${item.approvalId} was ${item.status}${item.reason === undefined ? "" : ` (${item.reason})`}; do not attempt that action without a new approval.`,
        );
        break;
      case "recovered":
        lines.push("The previous attempt stopped unexpectedly; resume from the last checkpoint.");
        break;
      case "resumed":
        lines.push("The user resumed this task after pausing it.");
        break;
      case "retry":
        lines.push(
          item.fromStepId === null
            ? "The user asked to retry this task."
            : `The user asked to retry from step ${item.fromStepId}.`,
        );
        break;
      case "reconciled":
        lines.push(
          `Step ${item.stepId} was reconciled as ${item.status}${item.note === undefined ? "" : `: ${item.note}`}.`,
        );
        break;
    }
  }
  return { text: lines.join("\n") };
}

/**
 * In-process worker pool (architecture §4.5). Each slot claims a task with a lease, runs one
 * `AgentLoop` turn for it while renewing the lease, records checkpoints and Activity lines from
 * the loop's events, and parks or settles the task when the turn ends. Pausing or cancelling a
 * task mid-turn aborts it at once and revokes the run's tool and approval authority.
 */
export class TaskWorkerPool {
  readonly #o: Required<
    Pick<TaskWorkerPoolOptions, "owner" | "concurrency" | "leaseMs" | "renewEveryMs" | "pollMs">
  > &
    TaskWorkerPoolOptions;
  readonly #timers: Timers;
  readonly #active = new Map<string, ActiveTurn>();
  readonly #watching = new Map<string, AbortController>();
  #running = false;
  #slots: Promise<void>[] = [];
  #wake: (() => void)[] = [];
  #unsubscribe: (() => void) | undefined;
  #runCounter = 0;

  constructor(options: TaskWorkerPoolOptions) {
    const leaseMs = options.leaseMs ?? 60_000;
    this.#o = {
      ...options,
      owner: options.owner ?? "gateway",
      concurrency: options.concurrency ?? 2,
      leaseMs,
      renewEveryMs: options.renewEveryMs ?? Math.floor(leaseMs / 3),
      pollMs: options.pollMs ?? 5_000,
    };
    this.#timers = options.timers ?? systemTimers;
    // Cancellation or pause from anywhere (API, chat, another process) stops the live turn.
    this.#unsubscribe = options.engine.subscribe((e) => {
      if (e.event !== "task.updated") return;
      const turn = this.#active.get(e.payload.task.id);
      if (turn === undefined) return;
      if (e.payload.task.status === "cancelled") turn.stop("cancelled");
      else if (e.payload.task.status === "paused") turn.stop("paused");
    });
  }

  #replaySafe(tool: string): boolean {
    if (this.#o.isReplaySafe !== undefined) return this.#o.isReplaySafe(tool);
    const spec = this.#o.tools?.get(tool)?.spec;
    return spec !== undefined && SAFE_EFFECTS.includes(spec.sideEffect);
  }

  #runId(): string {
    if (this.#o.newRunId !== undefined) return this.#o.newRunId();
    this.#runCounter += 1;
    return `run_${this.#o.owner}_${this.clockNow()}_${this.#runCounter}`;
  }

  clockNow(): number {
    return this.#o.clock.now();
  }

  #error(e: unknown): void {
    this.#o.onError?.(e);
  }

  /** Start the slots; recovers expired leases and re-watches parked approvals first. */
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    await this.#o.engine.recoverExpired();
    for (const { taskId, approvalId } of this.#o.engine.parkedOnApprovals()) {
      this.watchApproval(taskId, approvalId);
    }
    for (let i = 0; i < this.#o.concurrency; i += 1) {
      this.#slots.push(this.#slot(`${this.#o.owner}/${i}`));
    }
  }

  /** Stop claiming; running turns finish. */
  async stop(): Promise<void> {
    this.#running = false;
    this.poke();
    await Promise.all(this.#slots);
    this.#slots = [];
    for (const c of this.#watching.values()) c.abort();
    this.#watching.clear();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** Wake idle slots (a task was queued). */
  poke(): void {
    const wake = this.#wake;
    this.#wake = [];
    for (const w of wake) w();
  }

  async #slot(owner: string): Promise<void> {
    while (this.#running) {
      let report: TurnReport | undefined;
      try {
        report = await this.runOnce({ owner });
      } catch (e) {
        this.#error(e);
      }
      if (report !== undefined || !this.#running) continue;
      await new Promise<void>((resolve) => {
        const handle = this.#timers.setTimeout(done, this.#o.pollMs);
        function done() {
          resolve();
        }
        this.#wake.push(() => {
          this.#timers.clearTimeout(handle);
          resolve();
        });
      });
    }
  }

  /** Claim one task (the next queued one, or `taskId`) and run one turn; `undefined` when idle. */
  async runOnce(
    options: { owner?: string; taskId?: string } = {},
  ): Promise<TurnReport | undefined> {
    const { engine, loop } = this.#o;
    const owner = options.owner ?? `${this.#o.owner}/0`;
    const claimOpts: ClaimOptions = {
      leaseMs: this.#o.leaseMs,
      ...this.#o.claim,
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    };
    let lease = await engine.claim(owner, claimOpts);
    if (lease === undefined) return undefined;
    const taskId = lease.taskId;
    const record = engine.getRecord(taskId);
    if (record === undefined) return undefined;
    const resume = engine.readResume(lease);
    const input = buildTurnInput(record, resume, await engine.checkpoints(taskId));
    const runId = this.#runId();
    const controller = new AbortController();
    const budget = record.budget ?? this.#o.defaultBudget ?? {};
    const startedAt = this.#o.clock.now();
    let stopped: "cancelled" | "paused" | "lease_lost" | "budget_exceeded" | undefined;
    let budgetReason = "";

    const stop = (reason: "cancelled" | "paused" | "lease_lost" | "budget_exceeded") => {
      if (stopped !== undefined) return;
      stopped = reason;
      controller.abort(new PsycheError("cancelled", `task ${reason}`));
      loop.cancel(runId, reason).catch((e) => this.#error(e));
      // Cancellation revokes the run's tool and approval authority immediately (§4.5).
      if (reason !== "lease_lost") {
        this.#o.broker?.revokeRunAuthority(runId).catch((e) => this.#error(e));
      }
    };
    this.#active.set(taskId, { runId, controller, stop });

    // Lease heartbeat. A failed renewal stops the turn; when the task was paused or cancelled
    // from another process, the stop carries that reason so authority is revoked too.
    let renewHandle: unknown;
    let settled = false;
    const scheduleRenew = () => {
      renewHandle = this.#timers.setTimeout(() => {
        const current = lease;
        if (current === undefined || stopped !== undefined || settled) return;
        engine.renew(current, this.#o.leaseMs).then(
          (l) => {
            if (settled) return;
            lease = l;
            scheduleRenew();
          },
          async () => {
            if (settled) return;
            const status = (await engine.get(taskId))?.status;
            stop(
              status === "cancelled" ? "cancelled" : status === "paused" ? "paused" : "lease_lost",
            );
          },
        );
      }, this.#o.renewEveryMs);
    };
    scheduleRenew();

    let outcome: RunOutcome = "failed";
    let error: string | undefined;
    let text = "";
    let steps = 0;
    let tokens = 0;
    let approval: ApprovalRequest | undefined;
    let inputRequest: (AgentEvent & { type: "question" })["inputRequest"] | undefined;
    const overBudget = (): boolean => {
      if (budget.maxSteps !== undefined && steps > budget.maxSteps) {
        budgetReason = `step budget (${budget.maxSteps}) exceeded`;
        return true;
      }
      if (budget.maxTokens !== undefined && tokens > budget.maxTokens) {
        budgetReason = `token budget (${budget.maxTokens}) exceeded`;
        return true;
      }
      if (budget.maxWallMs !== undefined && this.#o.clock.now() - startedAt > budget.maxWallMs) {
        budgetReason = `time budget (${budget.maxWallMs} ms) exceeded`;
        return true;
      }
      return false;
    };

    try {
      const permissionMode = (await this.#o.permissionModeFor?.(record.task)) ?? "balanced";
      const stream = loop.startTurn({
        threadId: record.task.threadId,
        runId,
        taskId,
        input,
        mode: record.runMode,
        permissionMode,
        signal: controller.signal,
        // Write-ahead (#63): the step is `running` on disk before the executor runs, so a crash
        // after the provider applied it is reconciled as `uncertain`, never re-sent.
        beforeDispatch: async (call) => {
          if (stopped !== undefined) throw new PsycheError("cancelled", `task ${stopped}`);
          await engine.checkpoint(taskId, {
            stepId: call.toolCallId,
            replaySafe: this.#replaySafe(call.tool),
            status: "running",
          });
        },
      });
      let acked = false;
      for await (const ev of stream) {
        // A worker that lost its lease writes nothing: another worker owns the task now.
        if (stopped === "lease_lost") continue;
        if (!acked && lease !== undefined && stopped === undefined) {
          // The turn has its input: the resume items it was told can go.
          acked = true;
          engine.ackResume(lease, resume.length);
        }
        if ((stopped === "cancelled" || stopped === "paused") && ev.type === "tool_call") {
          // An already-dispatched request finished after the stop: reconcile, never replay.
          if (ev.status === "ok" || ev.status === "failed") {
            await engine
              .reconcile(taskId, ev.toolCallId, {
                status: ev.status === "ok" ? "done" : "failed",
                note: `finished after the task was ${stopped}`,
              })
              .catch(() => undefined);
          }
          continue;
        }
        switch (ev.type) {
          case "tool_call": {
            const status = CHECKPOINT_STATUS[ev.status];
            if (status === undefined) break;
            const replaySafe = this.#replaySafe(ev.tool);
            try {
              await engine.checkpoint(taskId, {
                stepId: ev.toolCallId,
                replaySafe,
                status,
                ...(ev.status === "blocked" ? { payload: { blocked: true } } : {}),
              });
            } catch (e) {
              // A settled step keeps its status (a provider reusing tool-call ids, #65); say so
              // in the Activity instead of failing the turn.
              if (!(e instanceof PsycheError && e.code === "conflict")) throw e;
              await engine.addAction(taskId, {
                toolCallId: ev.toolCallId,
                level1: `Step ${ev.toolCallId} already settled; ${ev.tool} ${ev.status} not recorded`,
                level2: { tool: ev.tool, outcome: "conflict" },
              });
            }
            if (ev.status === "running") {
              steps += 1;
            } else {
              await engine.addAction(taskId, {
                toolCallId: ev.toolCallId,
                level1: ev.level1 ?? `${ev.tool} ${ev.status}`,
                level2: { tool: ev.tool, outcome: ev.status },
              });
            }
            break;
          }
          case "approval_requested":
            approval = ev.approval;
            break;
          case "question":
            inputRequest = ev.inputRequest;
            break;
          case "usage":
            tokens += ev.usage.input + ev.usage.output;
            break;
          case "chat.delta":
            if (text.length < SUMMARY_MAX) text += ev.delta;
            break;
          case "end":
            outcome = ev.outcome;
            error = ev.error;
            break;
          default:
            break;
        }
        if (stopped === undefined && ev.type !== "end" && overBudget()) stop("budget_exceeded");
      }
    } catch (e) {
      outcome = "failed";
      error = e instanceof Error ? e.message : String(e);
    } finally {
      settled = true;
      this.#timers.clearTimeout(renewHandle);
      if (this.#active.get(taskId)?.runId === runId) this.#active.delete(taskId);
    }

    const report = (o: TurnReport["outcome"]): TurnReport => ({
      taskId,
      runId,
      outcome: o,
      task: undefined,
    });

    if (stopped === "cancelled" || stopped === "paused") {
      const r = report("stopped");
      r.task = await engine.get(taskId);
      return r;
    }
    // Settle only while we still hold the lease; otherwise another worker owns the task now.
    try {
      if (lease === undefined) throw new PsycheError("conflict", "no lease");
      lease = await engine.renew(lease, this.#o.leaseMs);
    } catch {
      return { ...report("lease_lost"), task: await engine.get(taskId) };
    }

    const summary = text.trim().slice(0, SUMMARY_MAX);
    const held = lease;
    let task: Task | undefined;
    try {
      task = await this.#settle(taskId, held, {
        outcome,
        stopped,
        budgetReason,
        summary,
        error,
        approval,
        inputRequest,
      });
    } catch (e) {
      // A pause / cancel / lease change committed between our renew and the write wins.
      if (e instanceof PsycheError && e.code === "conflict") {
        return { ...report("lease_lost"), task: await engine.get(taskId) };
      }
      throw e;
    }
    if (stopped === "budget_exceeded") return { ...report("budget_exceeded"), task };
    return { ...report(outcome), task };
  }

  /** Writes a finished turn's result; every write is checked against `lease` in its transaction. */
  async #settle(
    taskId: string,
    lease: TaskLease,
    r: {
      outcome: RunOutcome;
      stopped: string | undefined;
      budgetReason: string;
      summary: string;
      error: string | undefined;
      approval: ApprovalRequest | undefined;
      inputRequest: InputRequest | undefined;
    },
  ): Promise<Task | undefined> {
    const { engine } = this.#o;
    const opts = { lease };
    const fail = async (summary: string, outcome: JsonObject) => {
      const t = await engine.updateStatus(taskId, "failed", { summary, outcome }, opts);
      await this.#notifyEnd(t);
      return t;
    };
    if (r.stopped === "budget_exceeded") {
      return fail(`Stopped: ${r.budgetReason}`, {
        result: "budget_exceeded",
        reason: r.budgetReason,
      });
    }
    switch (r.outcome) {
      case "final": {
        const t = await engine.updateStatus(
          taskId,
          "done",
          { summary: r.summary, outcome: { result: "final" } },
          opts,
        );
        await this.#notifyEnd(t);
        return t;
      }
      case "no_reply":
        return engine.updateStatus(
          taskId,
          "done",
          { summary: "NO_REPLY", outcome: { result: "no_reply" } },
          opts,
        );
      case "awaiting_approval": {
        if (r.approval === undefined) {
          return fail("The run waited on an approval it never requested", {
            result: "failed",
            error: "awaiting_approval without approval_requested",
          });
        }
        const t = await engine.parkForApproval(
          taskId,
          { approvalId: r.approval.id, stepId: r.approval.requestedBy.toolCallId ?? null },
          opts,
        );
        this.watchApproval(taskId, r.approval.id);
        return t;
      }
      case "awaiting_input": {
        if (r.inputRequest === undefined) {
          return fail("The run waited on input it never asked for", {
            result: "failed",
            error: "awaiting_input without question",
          });
        }
        await engine.requestInput(taskId, r.inputRequest.questions, {
          id: r.inputRequest.id,
          lease,
        });
        const t = await engine.get(taskId);
        if (t !== undefined) await this.#notifyInput(t, r.inputRequest.questions[0]?.question);
        return t;
      }
      case "cancelled": {
        // The loop stopped the run itself (a chat "stop"): pause rather than re-queue, so the
        // task does not restart in a tight loop; the owner resumes or cancels it.
        await engine.updateStatus(taskId, "paused", {}, opts);
        await engine.addAction(taskId, {
          level1: "Stopped by the agent; paused",
          level2: { tool: "task.pause", outcome: "cancelled" },
        });
        return engine.get(taskId);
      }
      case "failed":
        return fail(r.error ?? "The run failed", {
          result: "failed",
          ...(r.error === undefined ? {} : { error: r.error }),
        });
    }
  }

  /**
   * Resolve the task when its approval is decided: granted / denied → re-queued with the
   * decision; expired → the step is re-queued (security §3.7); a restart's re-issue is picked
   * up through `onApprovalsReissued`.
   */
  watchApproval(taskId: string, approvalId: string): void {
    const broker = this.#o.broker;
    if (broker === undefined) return;
    this.#watching.get(taskId)?.abort();
    const controller = new AbortController();
    this.#watching.set(taskId, controller);
    broker
      .awaitDecision(approvalId, controller.signal)
      .then(async (decided) => {
        if (this.#watching.get(taskId) === controller) this.#watching.delete(taskId);
        const task = await this.#o.engine.resolveApproval(taskId, decided);
        if (task?.status === "queued") this.poke();
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        this.#error(e);
      });
  }

  /** Gateway boot: `PermissionBroker.reissue()` replaced parked approvals with fresh ones. */
  async onApprovalsReissued(issued: IssuedApproval[]): Promise<void> {
    for (const { approval } of issued) {
      const taskId = approval.requestedBy.taskId;
      if (taskId == null) continue;
      if (await this.#o.engine.rebindApproval(taskId, approval.id)) {
        this.watchApproval(taskId, approval.id);
      }
    }
  }

  get activeTaskIds(): string[] {
    return [...this.#active.keys()];
  }

  async #notifyEnd(task: Task): Promise<void> {
    const n = this.#o.notifier;
    // Automation runs are delivered by the scheduler; chat-attended tasks show in the thread.
    if (n === undefined || task.createdFrom === "automation") return;
    try {
      await n.notify({
        kind: task.status === "done" ? "task_done" : "task_failed",
        title: task.title,
        body: task.summary ?? "",
        taskId: task.id,
        route: `/tasks/${task.id}`,
      });
    } catch (e) {
      this.#error(e);
    }
  }

  async #notifyInput(task: Task, question: string | undefined): Promise<void> {
    const n = this.#o.notifier;
    if (n === undefined) return;
    try {
      await n.notify({
        kind: "input_needed",
        title: task.title,
        body: question ?? "The task needs your input",
        taskId: task.id,
        route: `/tasks/${task.id}`,
      });
    } catch (e) {
      this.#error(e);
    }
  }
}
