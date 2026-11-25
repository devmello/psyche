import type { AgentToolRegistry } from "@psyche/agent-core";
import { connectorToolName } from "@psyche/agent-core";
import {
  createThread,
  fileBranchReport,
  getPlanFork,
  getPlanForkBranch,
  getThread,
  insertStagedAction,
  listPlanForkBranches,
  listPlanForksByStatus,
  listStagedActionsForBranch,
  type PsycheDb,
  updatePlanFork,
  updatePlanForkBranch,
  updateStagedAction,
} from "@psyche/db";
import { AiSdkAdapter, isLocalKind, type ModelRouter, Prices } from "@psyche/model-router";
import {
  createForkStager,
  ForkService,
  type ForkStagerDeps,
  type ForkStore,
  type ForkTasks,
} from "@psyche/proactive";
import type { Clock, PlanForkUpdate, Staging, Task, Usage } from "@psyche/protocol";
import type { TaskWorkerPool } from "@psyche/tasks";

/**
 * Plan forks in the Gateway (docs/design/fork-a-plan-2026.md §2.3, §3, §6): the runner wired to
 * the real stores, the task engine and the night shift's adapter parts. It owns the `fork` worker
 * pool's claim rules (`origins: ["fork"]`, two slots, one for a local model) while the chat pool
 * and the specialist pool exclude fork tasks. `planForks.*` handlers are F4's; they call
 * `queueFork`, `cancel` and `reports` of the service built here.
 */

export interface ForkSetup {
  db: PsycheDb;
  clock: Clock;
  tasks: ForkTasks & {
    subscribe(listener: (e: { event: string; payload: { task?: Task } }) => void): () => void;
  };
  /** Wakes the fork pool. */
  poke: () => void;
  registry: AgentToolRegistry;
  /** The night shift's adapter parts (the same adapters, connectors and rehash). */
  stagerParts: {
    adapters: Parameters<typeof createForkStager>[0]["adapters"];
    connectors: () => ReadonlyMap<string, string>;
    domains: Parameters<typeof createForkStager>[0]["domains"];
    rehash: NonNullable<Parameters<typeof createForkStager>[0]["rehash"]>;
    refresh: () => Promise<void>;
  };
  router?: ModelRouter | undefined;
  /** Model prices; the bundled table by default. */
  prices?: Prices;
  resolvePerson?: (personId: string) => boolean;
  redact?: (text: string) => string;
  publish?: (event: string, payload: unknown) => void;
  logger?: { log(level: "warn", msg: string, fields?: Record<string, unknown>): void };
  onCompare?: (forkId: string) => void | Promise<void>;
}

export function forkStoreFor(db: PsycheDb): ForkStore {
  return {
    getFork: (id) => getPlanFork(db, id),
    updateFork: (id, patch) => updatePlanFork(db, id, patch),
    listForksByStatus: (statuses) => listPlanForksByStatus(db, statuses),
    listBranches: (forkId) => listPlanForkBranches(db, forkId),
    getBranch: (id) => getPlanForkBranch(db, id),
    updateBranch: (id, patch) => updatePlanForkBranch(db, id, patch),
    fileReport: (id, report, extra) => fileBranchReport(db, id, report, extra),
    listStaged: (branchId) => listStagedActionsForBranch(db, branchId),
    dismissStaged: (id) =>
      void updateStagedAction(db, id, { status: "dismissed", clearParams: true }),
  };
}

/** Whether the model a thread runs on is a local one, so the fork pool runs one branch at a time. */
export function threadModelIsLocal(router: ModelRouter | undefined, threadId: string): boolean {
  if (router === undefined) return false;
  const ref = router.threadModel(threadId) ?? router.role("primary")?.model;
  if (ref === undefined) return false;
  const providerId = ref.split("/")[0];
  const provider = router.providers().find((p) => p.id === providerId);
  return provider instanceof AiSdkAdapter && isLocalKind(provider.config.kind);
}

/** The dollars per token of a thread's model, and the most it writes in a call; none for a local model. */
export function threadModelPrice(
  router: ModelRouter | undefined,
  prices: Prices,
  threadId: string,
): { inputPerToken: number; outputPerToken: number; maxOutputTokens: number } | undefined {
  if (router === undefined) return undefined;
  const ref = router.threadModel(threadId) ?? router.role("primary")?.model;
  if (ref === undefined) return undefined;
  const entry = prices.lookup(ref as never);
  if (entry === undefined || entry.mode !== "chat") return undefined;
  return {
    inputPerToken: entry.input / 1_000_000,
    outputPerToken: entry.output / 1_000_000,
    maxOutputTokens: Math.min(entry.maxOutput ?? 8_192, 8_192),
  };
}

export function composeForks(setup: ForkSetup) {
  const { db } = setup;
  const prices = setup.prices ?? new Prices();
  let digestN = 0;
  const store = forkStoreFor(db);
  const nightStore: ForkStagerDeps["store"] = {
    insertStagedAction: (i) => insertStagedAction(db, i),
    listStagedActions: () => [],
    updateStagedAction: (id, p) => updateStagedAction(db, id, p),
    listStagedActionsForBranch: (id) => listStagedActionsForBranch(db, id),
  };

  const service = new ForkService({
    clock: setup.clock,
    store,
    tasks: setup.tasks,
    poke: setup.poke,
    stager: (branch, live) =>
      createForkStager({
        forkId: branch.forkId,
        branchId: branch.id,
        live,
        store: nightStore,
        adapters: setup.stagerParts.adapters,
        connectors: setup.stagerParts.connectors,
        domains: setup.stagerParts.domains,
        rehash: setup.stagerParts.rehash,
        ...(setup.redact === undefined ? {} : { redact: setup.redact }),
        onRefused: (info) =>
          setup.logger?.log("warn", "plan fork refused a staged call", { ...info }),
      }),
    toolInfo: (tool) => {
      const reg = setup.registry.get(tool);
      if (reg === undefined) return undefined;
      const id = connectorToolName(tool)?.id;
      return {
        sideEffect: reg.spec.sideEffect,
        connectorType: id === undefined ? undefined : setup.stagerParts.connectors().get(id),
      };
    },
    isLocalModel: (threadId) => threadModelIsLocal(setup.router, threadId),
    modelPrice: (threadId) => threadModelPrice(setup.router, prices, threadId),
    findBranchTask: async (branchId) => {
      // The branch's main task, if one exists already (never its forced report).
      const row = db.sqlite
        .prepare(
          `SELECT id FROM tasks
            WHERE created_from = 'fork' AND json_extract(staging, '$.branchId') = ?
              AND title NOT LIKE 'Plan report: %'
            ORDER BY created_at, id LIMIT 1`,
        )
        .get(branchId) as { id: string } | undefined;
      return row === undefined ? undefined : setup.tasks.get(row.id);
    },
    domains: () => setup.stagerParts.domains(),
    digestThread: (branch) => {
      // The forced report starts here, not in the branch's long transcript (fork-a-plan §6).
      const source = getThread(db, branch.threadId);
      digestN += 1;
      return createThread(db, {
        kind: "subagent",
        parentThreadId: branch.threadId,
        sessionKey: `fork-digest:${branch.id}:${digestN}:${setup.clock.now()}`,
        title: "Plan report",
        titleSource: "user",
        ...(source?.modelRef == null ? {} : { modelRef: source.modelRef }),
        ...(source?.permissionMode == null ? {} : { permissionMode: source.permissionMode }),
      }).id;
    },
    ...(setup.resolvePerson === undefined ? {} : { resolvePerson: setup.resolvePerson }),
    publish: (event, payload: PlanForkUpdate) => setup.publish?.(event, payload),
    ...(setup.onCompare === undefined ? {} : { onCompare: setup.onCompare }),
    ...(setup.logger === undefined ? {} : { logger: setup.logger }),
  });

  // A fork task's start and end move its branch along.
  const off = setup.tasks.subscribe((e) => {
    const task = e.payload.task;
    if (e.event === "task.updated" && task !== undefined && task.createdFrom === "fork") {
      void service.onTaskUpdated(task).catch((err) =>
        setup.logger?.log("warn", "plan fork task update failed", {
          code: (err as { code?: string }).code ?? "internal",
        }),
      );
    }
  });

  return {
    service,
    /** `TaskWorkerPool.stagingSinkFor`, `stagingToolsFor` and `stagingReadsFor` for a fork task. */
    sinkFor: (staging: Staging) => service.sinkFor(staging),
    toolsFor: (staging: Staging, task: Task) => service.toolsFor(staging, task),
    readsFor: (staging: Staging) => service.readsFor(staging),
    meter: (taskId: string, usage: Usage, runId?: string) => service.meter(taskId, usage, runId),
    /** The fork pool's slot rule: two at a time, one for a local model. */
    canClaim: (pool: Pick<TaskWorkerPool, "activeTaskIds">) =>
      service.canClaim(pool.activeTaskIds.length),
    async start() {
      await setup.stagerParts.refresh().catch(() => undefined);
      await service.recover();
    },
    stop() {
      off();
    },
  };
}

/** The fork pool's claim: only `fork` tasks. The chat and specialist pools exclude them. */
export const FORK_POOL_CLAIM: { origins: "fork"[] } = { origins: ["fork"] };
