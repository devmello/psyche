import {
  type MethodParams,
  type MethodResult,
  type PermissionBroker,
  PsycheError,
} from "@psyche/protocol";
import type { SqliteTaskEngine } from "./engine.ts";
import type { TaskWorkerPool } from "./worker.ts";

type TaskMethod =
  | "tasks.list"
  | "tasks.get"
  | "tasks.pause"
  | "tasks.resume"
  | "tasks.cancel"
  | "tasks.retry"
  | "tasks.actions";

export type TaskHandlers = {
  [M in TaskMethod]: (params: MethodParams<M>) => Promise<MethodResult<M>>;
};

export interface TaskHandlerDeps {
  engine: SqliteTaskEngine;
  /** Woken when a handler re-queues a task. */
  pool?: TaskWorkerPool;
  /** Pending approvals of a cancelled task are invalidated. */
  broker?: PermissionBroker;
}

/**
 * `tasks.*` handlers for the Gateway to mount (S01 validates params and scopes before calling
 * them). Cancelling a live task also stops its turn through the worker pool's subscription.
 */
export function createTaskHandlers(deps: TaskHandlerDeps): TaskHandlers {
  const { engine, pool } = deps;
  const get = async (taskId: string) => {
    const task = await engine.get(taskId);
    if (task === undefined) throw new PsycheError("not_found", `task ${taskId} not found`);
    return { task };
  };
  return {
    "tasks.list": async (p) => {
      const page = engine.listPage({
        ...(p.status === undefined ? {} : { status: p.status }),
        ...(p.threadId === undefined ? {} : { threadId: p.threadId }),
        ...(p.cursor === undefined ? {} : { cursor: p.cursor }),
        limit: Math.min(p.limit ?? 50, 200),
      });
      return { tasks: page.items, nextCursor: page.nextCursor };
    },
    "tasks.get": (p) => get(p.taskId),
    "tasks.pause": async (p) => ({ task: await engine.pause(p.taskId) }),
    "tasks.resume": async (p) => {
      const task = await engine.resume(p.taskId);
      pool?.poke();
      return { task };
    },
    "tasks.cancel": async (p) => {
      const task = await engine.cancel(p.taskId, "Cancelled by the owner");
      if (deps.broker !== undefined) {
        // Approvals still pending for this task can no longer be answered.
        for (const a of await deps.broker.list({ status: "pending" })) {
          if (a.requestedBy.taskId === p.taskId && a.requestedBy.runId != null) {
            await deps.broker.revokeRunAuthority(a.requestedBy.runId);
          }
        }
      }
      return { task };
    },
    "tasks.retry": async (p) => {
      const task = await engine.retry(
        p.taskId,
        p.fromStepId === undefined ? {} : { fromStepId: p.fromStepId },
      );
      pool?.poke();
      return { task };
    },
    "tasks.actions": async (p) => {
      await get(p.taskId);
      const page = engine.actionsPage(p.taskId, {
        ...(p.cursor === undefined ? {} : { cursor: p.cursor }),
        limit: Math.min(p.limit ?? 100, 500),
      });
      return { actions: page.items, nextCursor: page.nextCursor };
    },
  };
}
