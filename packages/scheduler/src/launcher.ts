import type { AutomationRun, Task } from "@psyche/protocol";
import { TERMINAL_TASK_STATUSES } from "@psyche/protocol";
import type { SqliteTaskEngine, TaskBudget, TaskWorkerPool } from "@psyche/tasks";
import type { RunLauncher, RunResult } from "./types.ts";

function resultOf(task: Task): RunResult {
  const base = { taskId: task.id };
  if (task.status === "done") {
    return task.outcome?.result === "no_reply"
      ? { ...base, status: "no_reply", summary: null }
      : { ...base, status: "done", summary: task.summary ?? null };
  }
  if (task.status === "cancelled")
    return { ...base, status: "cancelled", summary: task.summary ?? null };
  return { ...base, status: "failed", summary: task.summary ?? null };
}

/**
 * Runs each automation as an unattended Task (`createdFrom: automation`) on the worker pool and
 * resolves when the task ends. A task parked on an approval keeps the run `running` until it is
 * decided (the approval sits in the queue with a notification; nobody is asked inline).
 */
export function createTaskLauncher(options: {
  engine: SqliteTaskEngine;
  pool?: TaskWorkerPool;
  budget?: TaskBudget;
}): RunLauncher {
  const { engine, pool } = options;
  const settle = (taskId: string): Promise<RunResult> =>
    new Promise((resolve) => {
      const unsubscribe = engine.subscribe((e) => {
        if (e.event !== "task.updated" || e.payload.task.id !== taskId) return;
        if (!TERMINAL_TASK_STATUSES.includes(e.payload.task.status)) return;
        unsubscribe();
        resolve(resultOf(e.payload.task));
      });
      // It may already have ended.
      engine.get(taskId).then((t) => {
        if (t === undefined) {
          unsubscribe();
          resolve({ status: "failed", summary: "The task disappeared", taskId });
        } else if (TERMINAL_TASK_STATUSES.includes(t.status)) {
          unsubscribe();
          resolve(resultOf(t));
        }
      });
    });
  return {
    async launch(request) {
      const task = await engine.create({
        threadId: request.threadId,
        title: request.automation.title,
        goal: request.prompt,
        createdFrom: "automation",
        mode: "unattended",
        ...(options.budget === undefined ? {} : { budget: options.budget }),
      });
      const result = settle(task.id);
      pool?.poke();
      return { taskId: task.id, result };
    },
    reattach(run: AutomationRun) {
      return run.taskId == null ? undefined : settle(run.taskId);
    },
    async cancel(run: AutomationRun, reason: string) {
      if (run.taskId == null) return;
      const task = await engine.get(run.taskId);
      if (task !== undefined && !TERMINAL_TASK_STATUSES.includes(task.status)) {
        await engine.cancel(run.taskId, reason);
      }
    },
  };
}
