import {
  type Clock,
  type ForkReport,
  type PlanFork,
  type PlanForkBranch,
  type PlanForkBranchStatus,
  type PlanForkStatus,
  type PlanForkUpdate,
  PsycheError,
  type SideEffect,
  type StagedAction,
  type Staging,
  type StagingReads,
  type StagingSink,
  type TaintSource,
  type Task,
  type Usage,
} from "@psyche/protocol";
import {
  branchCaps,
  FORCED_REPORT_CAPS,
  FORK_BRANCH_CAPS,
  ForkBudget,
  type Lane,
} from "./budget.ts";
import {
  BRANCH_TITLE_PREFIX,
  buildBranchGoal,
  buildForcedReportGoal,
  FORCED_TITLE_PREFIX,
  plainLabel,
} from "./prompt.ts";
import { BranchReads } from "./reads.ts";
import { checkReport } from "./report-check.ts";
import { forcedReportToolVisible, forkToolVisible } from "./toolset.ts";

/**
 * The branch runner (docs/design/fork-a-plan-2026.md §2.3, §3, §6). It does not create forks (that
 * is `planForks.create`, F4): given a fork row with its branches and their hidden threads, it
 *
 * - queues one task per branch (`createdFrom: "fork"`, unattended, the server-only `staging`
 *   block, the branch's share of the budget);
 * - hands the task worker what a staging task needs: the sink (`sinkFor`), the toolset
 *   (`toolsFor`), the read guard that holds `web.fetch` to the branch's own search results
 *   (`readsFor`) and the usage meter (`meter`);
 * - files each branch's one report (`ForkReportHost`), with the checked report written by a single
 *   `WHERE report IS NULL AND status = 'running'` statement;
 * - forces a report from the reserve when a branch ends without one, and fails it as `no_report`
 *   when that does not work;
 * - tracks the branches to their end, hands a fork with two or more reports to the comparison, and
 *   recovers an unfinished fork after a restart;
 * - cancels one branch or all of them. Cancelling ends the task (the worker's `stop("cancelled")`
 *   revokes the run's authority) and, in the same step, makes the sink and the report refuse.
 *
 * Nothing here runs a tool or touches the world: a branch only reads and stages.
 */

const BRANCH_TERMINAL: ReadonlySet<PlanForkBranchStatus> = new Set([
  "reported",
  "failed",
  "cancelled",
  "budget_stopped",
]);
const TASK_TERMINAL: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);
const LIVE_FORK: ReadonlySet<PlanForkStatus> = new Set(["running", "comparing"]);

/** A branch started longer ago than this many wall budgets has used its time up at recovery. */
export const RECOVERY_WALL_FACTOR = 2;

export interface ForkStore {
  getFork(id: string): PlanFork | null;
  updateFork(
    id: string,
    patch: {
      status?: PlanForkStatus;
      error?: string | null;
      spentUsd?: number;
      tokens?: number;
      finishedAt?: string | null;
    },
  ): PlanFork | null;
  listForksByStatus(statuses: PlanForkStatus[]): PlanFork[];
  listBranches(forkId: string): PlanForkBranch[];
  getBranch(id: string): PlanForkBranch | null;
  updateBranch(
    id: string,
    patch: {
      taskId?: string | null;
      status?: PlanForkBranchStatus;
      error?: string | null;
      taint?: boolean;
      taintSources?: readonly TaintSource[];
      spentUsd?: number;
      tokens?: number;
      startedAt?: string | null;
      finishedAt?: string | null;
    },
  ): PlanForkBranch | null;
  /** One statement: writes only while the branch is `running` with no report. */
  fileReport(branchId: string, report: ForkReport, extra: { readOwnerOnly?: boolean }): boolean;
  listStaged(branchId: string): StagedAction[];
  dismissStaged(id: string): void;
}

export interface ForkTasks {
  create(input: {
    threadId: string;
    title: string;
    goal: string;
    createdFrom: "fork";
    mode: "unattended";
    budget: { maxSteps?: number; maxTokens?: number; maxWallMs?: number };
    staging: Staging;
    taint?: boolean;
    taintSources?: TaintSource[];
  }): Promise<Task>;
  get(id: string): Promise<Task | undefined>;
  cancel(id: string, reason: string): Promise<unknown>;
}

export interface ForkServiceDeps {
  clock: Clock;
  store: ForkStore;
  tasks: ForkTasks;
  /** Wakes the fork pool after a task is created. */
  poke: () => void;
  /** The branch's staging sink (the Night shift adapters over this branch's rows). */
  stager: (branch: PlanForkBranch, live: () => boolean) => StagingSink;
  /** A registered tool's side effect and, for a connector tool, its connector's type. */
  toolInfo: (
    tool: string,
  ) => { sideEffect: SideEffect; connectorType?: string | undefined } | undefined;
  /** Whether the model a thread runs on is a local one (one slot, not two). */
  isLocalModel?: (threadId: string) => boolean;
  /** Price per token of the thread's model, to lower a branch's token cap (§6). */
  usdPerToken?: (threadId: string) => number | undefined;
  /** True when the id resolves in Memory's people store (§4.2). */
  resolvePerson?: (personId: string) => boolean;
  publish?: (event: "planFork.updated", payload: PlanForkUpdate) => void;
  /** A fork has two or more reports: run the comparison pass (F3, wired by F4). */
  onCompare?: (forkId: string) => void | Promise<void>;
  logger?: { log(level: "warn", msg: string, fields?: Record<string, unknown>): void };
}

interface TaskRef {
  forkId: string;
  branchId: string;
  lane: Lane;
}

const isBudgetEnd = (task: Task): boolean => {
  const outcome = (task as { outcome?: { result?: unknown } | null }).outcome;
  return outcome?.result === "budget_exceeded" || (task.summary ?? "").startsWith("Stopped: ");
};

export class ForkService {
  readonly #d: ForkServiceDeps;
  readonly #budgets = new Map<string, ForkBudget>();
  readonly #reads = new Map<string, BranchReads>();
  readonly #taskRefs = new Map<string, TaskRef>();
  /** Branches the owner cancelled: the sink and the report refuse at once. */
  readonly #cancelRequested = new Set<string>();
  readonly #cancelledForks = new Set<string>();
  /** Branches stopped for their money share or the fork's cap. */
  readonly #budgetStopped = new Set<string>();
  /** Tasks already told to stop for their budget. */
  readonly #stopping = new Set<string>();
  /** One chain per fork: task events of a fork are handled one at a time. */
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(deps: ForkServiceDeps) {
    this.#d = deps;
  }

  // --- What the task worker asks for ---------------------------------------------------------

  /** `TaskWorkerPool.stagingSinkFor`. */
  sinkFor(staging: Staging): StagingSink | undefined {
    if (staging.kind !== "fork") return undefined;
    const branch = this.#d.store.getBranch(staging.branchId);
    if (branch === null || branch.forkId !== staging.forkId) return undefined;
    if (!this.#live(branch.id)) return undefined;
    return this.#d.stager(branch, () => this.#live(branch.id));
  }

  /** `TaskWorkerPool.stagingToolsFor`: the §3.2 toolset, or only the report for a forced task. */
  toolsFor(staging: Staging, task: Task): ((tool: string) => boolean) | undefined {
    if (staging.kind !== "fork") return undefined;
    const forced = task.title.startsWith(FORCED_TITLE_PREFIX);
    return (tool: string): boolean => {
      const info = this.#d.toolInfo(tool);
      if (info === undefined) return false;
      const input = { tool, sideEffect: info.sideEffect, connectorType: info.connectorType };
      return forced ? forcedReportToolVisible(input) : forkToolVisible(input);
    };
  }

  /** `TaskWorkerPool.stagingReadsFor`: the branch's guard (the fetch rule and the call record). */
  readsFor(staging: Staging): StagingReads | undefined {
    if (staging.kind !== "fork") return undefined;
    return this.#readsOf(staging.branchId);
  }

  /** Usage events of every task run; only a fork task's count. */
  meter(taskId: string, usage: Usage, runId?: string): void {
    const ref = this.#taskRefs.get(taskId);
    if (ref === undefined) return;
    const budget = this.#budgets.get(ref.forkId);
    if (budget === undefined) return;
    const { overShare, overCap } = budget.add(ref.branchId, ref.lane, usage, runId ?? taskId);
    const used = budget.branchUsed(ref.branchId);
    const forced = budget.forcedUsed(ref.branchId);
    const total = budget.state;
    try {
      this.#d.store.updateBranch(ref.branchId, {
        spentUsd: used.usd + forced.usd,
        tokens: used.tokens + forced.tokens,
      });
      this.#d.store.updateFork(ref.forkId, { spentUsd: total.spentUsd, tokens: total.tokens });
    } catch (err) {
      this.#warn("fork spend not saved", err);
    }
    this.#publish(ref.forkId);
    if (overCap) {
      for (const b of this.#d.store.listBranches(ref.forkId)) {
        if (!BRANCH_TERMINAL.has(b.status)) this.#stopForBudget(b);
      }
    } else if (overShare) {
      const b = this.#d.store.getBranch(ref.branchId);
      if (b !== null) this.#stopForBudget(b);
    }
  }

  /** Whether the pool may start another turn: two at a time, one when a local model is in use. */
  canClaim(active: number): boolean {
    return active < this.slotLimit();
  }

  /** 2 slots, or 1 when the model of any live branch's thread is a local one (§2.3). */
  slotLimit(): number {
    const isLocal = this.#d.isLocalModel;
    if (isLocal === undefined) return 2;
    for (const fork of this.#d.store.listForksByStatus(["running"])) {
      for (const b of this.#d.store.listBranches(fork.id)) {
        if (!BRANCH_TERMINAL.has(b.status) && isLocal(b.threadId)) return 1;
      }
    }
    return 2;
  }

  // --- Starting -----------------------------------------------------------------------------

  /** Queues the task of every branch of a running fork that has none yet. */
  async queueFork(forkId: string): Promise<void> {
    const fork = this.#d.store.getFork(forkId);
    if (fork === null || fork.status !== "running") {
      throw new PsycheError("conflict", "the fork is not running");
    }
    const branches = this.#d.store.listBranches(forkId);
    const budget = this.#budgetOf(fork, branches.length);
    for (const b of branches) {
      if (b.status !== "queued" || b.taskId != null) continue;
      const caps = branchCaps(budget.split, branches.length, {
        ...(this.#d.usdPerToken === undefined
          ? {}
          : { usdPerToken: this.#d.usdPerToken(b.threadId) }),
      });
      const task = await this.#d.tasks.create({
        threadId: b.threadId,
        title: `${BRANCH_TITLE_PREFIX}${plainLabel(b.label)}`,
        goal: buildBranchGoal({ label: b.label, premise: b.premise }),
        createdFrom: "fork",
        mode: "unattended",
        budget: caps,
        staging: { kind: "fork", forkId, branchId: b.id },
      });
      this.#taskRefs.set(task.id, { forkId, branchId: b.id, lane: "branch" });
      this.#d.store.updateBranch(b.id, { taskId: task.id });
    }
    this.#d.poke();
    this.#publish(forkId);
  }

  // --- The report ---------------------------------------------------------------------------

  /**
   * `AgentLoopOptions.forkReports`: stores the branch's one report, checked against what this
   * branch's run read. The single write is `WHERE report IS NULL AND status = 'running'`: a second
   * filing (a model retrying after a host that committed and then threw, a run replayed after a
   * restart) is `conflict` and changes nothing. Whatever runs after the commit cannot undo it.
   */
  readonly reports = {
    file: async (input: {
      forkId: string;
      branchId: string;
      runId: string;
      toolCallId: string;
      report: ForkReport;
    }): Promise<void> => {
      const branch = this.#d.store.getBranch(input.branchId);
      if (branch === null || branch.forkId !== input.forkId) {
        throw new PsycheError("not_found", "no such plan branch");
      }
      if (branch.status === "queued" && !this.#cancelRequested.has(branch.id)) {
        // The report beat the task's `running` event to the branch row.
        this.#d.store.updateBranch(branch.id, {
          status: "running",
          startedAt: new Date(this.#d.clock.now()).toISOString(),
        });
        branch.status = "running";
      }
      if (branch.status !== "running" || this.#cancelRequested.has(branch.id)) {
        throw new PsycheError("conflict", "the branch is not taking a report");
      }
      const checked = checkReport(input.report, {
        calls: this.#readsOf(branch.id).calls(),
        resolvePerson: this.#d.resolvePerson ?? (() => false),
        liveStagedIds: new Set(
          this.#d.store
            .listStaged(branch.id)
            .filter((i) => i.status === "ready")
            .map((i) => i.id),
        ),
      });
      const wrote = this.#d.store.fileReport(branch.id, checked.report, {
        readOwnerOnly: checked.readOwnerOnly || branch.readOwnerOnly,
      });
      if (!wrote) throw new PsycheError("conflict", "the report was already filed");
      // Whatever follows the commit (the event, anything a later change adds) cannot undo it.
      this.#publish(input.forkId);
    },
  };

  // --- Task events --------------------------------------------------------------------------

  /** Every task update: a fork task's start and end move its branch along. */
  onTaskUpdated(task: Task): Promise<void> {
    const ref = this.#taskRefs.get(task.id);
    if (ref === undefined) return Promise.resolve();
    return this.#serial(ref.forkId, async () => {
      if (task.status === "running") {
        const b = this.#d.store.getBranch(ref.branchId);
        if (b !== null && b.status === "queued") {
          this.#d.store.updateBranch(b.id, {
            status: "running",
            startedAt: new Date(this.#d.clock.now()).toISOString(),
          });
          this.#publish(ref.forkId);
        }
        return;
      }
      if (TASK_TERMINAL.has(task.status)) await this.#ended(task, ref);
    });
  }

  // --- Cancel -------------------------------------------------------------------------------

  /**
   * `planForks.cancel`: one branch or all of them. The task is cancelled (the worker stops the
   * turn and revokes the run's authority) and the branch refuses the sink and the report from this
   * call on. Reports already filed are kept, staged items are dismissed.
   */
  async cancel(input: { forkId: string; branchId?: string }): Promise<void> {
    const fork = this.#d.store.getFork(input.forkId);
    if (fork === null) throw new PsycheError("not_found", "no such fork");
    if (!LIVE_FORK.has(fork.status)) throw new PsycheError("conflict", "the fork has ended");
    const all = this.#d.store.listBranches(fork.id);
    const targets = input.branchId === undefined ? all : all.filter((b) => b.id === input.branchId);
    if (input.branchId !== undefined && targets.length === 0) {
      throw new PsycheError("not_found", "no such branch");
    }
    if (input.branchId === undefined) this.#cancelledForks.add(fork.id);
    // Authority goes first, for every target, before any await.
    for (const b of targets) if (!BRANCH_TERMINAL.has(b.status)) this.#cancelRequested.add(b.id);
    for (const b of targets) {
      if (BRANCH_TERMINAL.has(b.status)) continue;
      if (b.taskId != null) {
        await this.#d.tasks.cancel(b.taskId, "cancelled").catch((err) => {
          this.#warn("fork task cancel failed", err);
        });
      }
    }
    await this.#serial(fork.id, async () => {
      for (const b of targets) {
        const now = this.#d.store.getBranch(b.id);
        if (now === null || BRANCH_TERMINAL.has(now.status)) continue;
        this.#finishBranch(now, now.report == null ? "cancelled" : "reported", null);
      }
      this.#settleFork(fork.id);
    });
  }

  // --- Recovery -----------------------------------------------------------------------------

  /**
   * After a restart (the task pool has already re-queued expired leases): a branch whose report
   * was committed before the crash is `reported` and never runs again; a branch with no task gets
   * one; a branch whose task ended while the Gateway was down is settled; a branch that started
   * more than `RECOVERY_WALL_FACTOR` wall budgets ago has used its time and is stopped (it goes
   * to the forced report like any budget stop); a fork in `comparing` is handed on again.
   */
  async recover(): Promise<void> {
    for (const fork of this.#d.store.listForksByStatus(["running", "comparing"])) {
      try {
        await this.#recoverFork(fork);
      } catch (err) {
        this.#warn("fork recovery failed", err);
      }
    }
  }

  async #recoverFork(fork: PlanFork): Promise<void> {
    if (fork.status === "comparing") {
      await Promise.resolve(this.#d.onCompare?.(fork.id)).catch((err) =>
        this.#warn("fork comparison failed", err),
      );
      return;
    }
    const branches = this.#d.store.listBranches(fork.id);
    const budget = this.#budgetOf(fork, branches.length);
    for (const b of branches) {
      if (b.spentUsd > 0 || b.tokens > 0) {
        budget.add(
          b.id,
          "branch",
          { input: b.tokens, output: 0, costUsd: b.spentUsd },
          `restore:${b.id}`,
        );
      }
    }
    for (const b of branches) {
      if (BRANCH_TERMINAL.has(b.status)) continue;
      if (b.report != null) {
        // Committed before the crash: one filing, never a second.
        await this.#serial(fork.id, async () => this.#finishBranch(b, "reported", null));
        continue;
      }
      if (b.taskId == null) continue; // queueFork creates it
      const task = await this.#d.tasks.get(b.taskId);
      if (task === undefined) {
        await this.#serial(fork.id, async () => this.#finishBranch(b, "failed", "task_lost"));
        continue;
      }
      const forced = task.title.startsWith(FORCED_TITLE_PREFIX);
      this.#taskRefs.set(task.id, {
        forkId: fork.id,
        branchId: b.id,
        lane: forced ? "forced" : "branch",
      });
      if (TASK_TERMINAL.has(task.status)) {
        await this.onTaskUpdated(task);
        continue;
      }
      const startedAt = b.startedAt == null ? undefined : Date.parse(b.startedAt);
      if (
        !forced &&
        startedAt !== undefined &&
        this.#d.clock.now() - startedAt > RECOVERY_WALL_FACTOR * FORK_BRANCH_CAPS.maxWallMs
      ) {
        this.#stopForBudget(b);
      }
    }
    await this.#serial(fork.id, async () => this.#settleFork(fork.id));
  }

  // --- Internals ----------------------------------------------------------------------------

  #live(branchId: string): boolean {
    if (this.#cancelRequested.has(branchId)) return false;
    const b = this.#d.store.getBranch(branchId);
    return b !== null && !BRANCH_TERMINAL.has(b.status);
  }

  #readsOf(branchId: string): BranchReads {
    let reads = this.#reads.get(branchId);
    if (reads === undefined) {
      reads = new BranchReads({
        onTaint: (sources) => {
          try {
            this.#d.store.updateBranch(branchId, { taint: true, taintSources: sources });
          } catch (err) {
            this.#warn("branch taint not saved", err);
          }
        },
      });
      this.#reads.set(branchId, reads);
    }
    return reads;
  }

  #budgetOf(fork: PlanFork, branches: number): ForkBudget {
    let b = this.#budgets.get(fork.id);
    if (b === undefined) {
      b = new ForkBudget(fork.budgetUsd, branches);
      this.#budgets.set(fork.id, b);
    }
    return b;
  }

  #serial<T>(forkId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#chains.get(forkId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.#chains.set(
      forkId,
      run.catch(() => undefined),
    );
    return run;
  }

  /** Stops a branch's running task for its share or the fork's cap; the end handler does the rest. */
  #stopForBudget(branch: PlanForkBranch): void {
    if (BRANCH_TERMINAL.has(branch.status) || branch.taskId == null) return;
    if (this.#stopping.has(branch.taskId)) return;
    this.#stopping.add(branch.taskId);
    const ref = this.#taskRefs.get(branch.taskId);
    if (ref?.lane !== "forced") this.#budgetStopped.add(branch.id);
    this.#d.tasks.cancel(branch.taskId, "budget").catch((err) => {
      this.#warn("fork task stop failed", err);
    });
  }

  async #ended(task: Task, ref: TaskRef): Promise<void> {
    const branch = this.#d.store.getBranch(ref.branchId);
    if (branch === null || BRANCH_TERMINAL.has(branch.status)) return;
    const stoppedForBudget = this.#budgetStopped.has(branch.id) || isBudgetEnd(task);
    const cancelled =
      this.#cancelRequested.has(branch.id) ||
      (task.status === "cancelled" && !stoppedForBudget && ref.lane === "branch");
    if (branch.report != null) {
      this.#finishBranch(branch, "reported", stoppedForBudget ? "budget_reached" : null);
    } else if (cancelled) {
      this.#finishBranch(branch, "cancelled", null);
    } else if (ref.lane === "forced") {
      this.#finishBranch(branch, "failed", "no_report");
    } else if (stoppedForBudget || task.status === "done") {
      const fork = this.#d.store.getFork(branch.forkId);
      const budget = fork === null ? undefined : this.#budgets.get(fork.id);
      if (fork !== null && budget !== undefined && budget.canForceReport()) {
        await this.#forceReport(fork, branch, budget);
        return;
      }
      this.#finishBranch(
        branch,
        stoppedForBudget ? "budget_stopped" : "failed",
        stoppedForBudget ? "budget_reached" : "no_report",
      );
    } else {
      this.#finishBranch(branch, "failed", "run_failed");
    }
    this.#settleFork(branch.forkId);
  }

  /** One forced `fork_report` from the reserve: a task whose only tool is the report. */
  async #forceReport(fork: PlanFork, branch: PlanForkBranch, budget: ForkBudget): Promise<void> {
    void budget;
    const fresh = this.#d.store.getBranch(branch.id);
    const task = await this.#d.tasks.create({
      threadId: branch.threadId,
      title: `${FORCED_TITLE_PREFIX}${plainLabel(branch.label)}`,
      goal: buildForcedReportGoal({ label: branch.label }),
      createdFrom: "fork",
      mode: "unattended",
      budget: { ...FORCED_REPORT_CAPS },
      staging: { kind: "fork", forkId: fork.id, branchId: branch.id },
      ...(fresh?.taint === true
        ? { taint: true, taintSources: [...(fresh.taintSources ?? [])] }
        : {}),
    });
    this.#taskRefs.set(task.id, { forkId: fork.id, branchId: branch.id, lane: "forced" });
    this.#d.store.updateBranch(branch.id, { taskId: task.id });
    this.#d.poke();
    this.#publish(fork.id);
  }

  #finishBranch(branch: PlanForkBranch, status: PlanForkBranchStatus, error: string | null): void {
    this.#d.store.updateBranch(branch.id, {
      status,
      error,
      finishedAt: new Date(this.#d.clock.now()).toISOString(),
    });
    if (status === "cancelled" || status === "failed") {
      for (const item of this.#d.store.listStaged(branch.id)) {
        if (item.status === "ready") this.#d.store.dismissStaged(item.id);
      }
    }
    this.#reads.delete(branch.id);
    this.#publish(branch.forkId);
  }

  /** When every branch has ended, the fork moves on (§2.4). */
  #settleFork(forkId: string): void {
    const fork = this.#d.store.getFork(forkId);
    if (fork === null || !LIVE_FORK.has(fork.status)) return;
    if (fork.status !== "running") return;
    const branches = this.#d.store.listBranches(forkId);
    if (branches.some((b) => !BRANCH_TERMINAL.has(b.status))) return;
    const now = new Date(this.#d.clock.now()).toISOString();
    const reported = branches.filter((b) => b.status === "reported").length;
    if (this.#cancelledForks.has(forkId)) {
      this.#d.store.updateFork(forkId, { status: "cancelled", finishedAt: now });
    } else if (reported >= 2) {
      this.#d.store.updateFork(forkId, { status: "comparing" });
      this.#publish(forkId);
      void Promise.resolve()
        .then(() => this.#d.onCompare?.(forkId))
        .catch((err) => this.#warn("fork comparison failed", err));
      return;
    } else {
      this.#d.store.updateFork(forkId, {
        status: "failed",
        error: "fewer_than_two_reports",
        finishedAt: now,
      });
    }
    this.#publish(forkId);
  }

  #publish(forkId: string): void {
    const fork = this.#d.store.getFork(forkId);
    if (fork === null) return;
    try {
      this.#d.publish?.("planFork.updated", {
        forkId,
        threadId: fork.threadId,
        status: fork.status,
        branches: this.#d.store.listBranches(forkId).map((b) => ({ id: b.id, status: b.status })),
        spentUsd: fork.spentUsd,
      });
    } catch (err) {
      // An event is a notice, never part of the state: a bus that throws changes nothing stored.
      this.#warn("fork update not published", err);
    }
  }

  #warn(msg: string, err: unknown): void {
    this.#d.logger?.log("warn", msg, { code: PsycheError.from(err).code });
  }
}
