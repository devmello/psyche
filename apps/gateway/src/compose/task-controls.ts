import {
  type MethodParams,
  type MethodResult,
  PsycheError,
  type Task,
  TERMINAL_TASK_STATUSES,
} from "@psyche/protocol";
import type { SqliteTaskEngine } from "@psyche/tasks";
import type { RoleSource } from "./specialists.ts";

/**
 * `tasks.update` (docs/agent/specialists-2026.md §4.7): the owner gives a specialist job more
 * budget or time ("Give it more"), never above its role's caps. The method is operator-scoped, so
 * only the owner reaches it; the parent agent has no tool for it.
 */

export interface TaskUpdateDeps {
  tasks: SqliteTaskEngine;
  roles: RoleSource;
  now: () => number;
  /** `raiseSpecialistBudget` of the composed Gateway. */
  raise: (
    taskId: string,
    patch: { tokens?: number; costUsd?: number; minutes?: number; deadline?: string },
  ) => Promise<Task>;
  /** Woken after a change, so a job that waits on its budget can go on. */
  poke?: () => void;
}

export function taskUpdateHandlers(deps: TaskUpdateDeps): {
  "tasks.update": (p: MethodParams<"tasks.update">) => Promise<MethodResult<"tasks.update">>;
} {
  return {
    "tasks.update": async (p) => {
      const task = await deps.tasks.get(p.taskId);
      if (task === undefined) throw new PsycheError("not_found", `task ${p.taskId} not found`);
      const spec = task.specialist;
      if (spec === undefined) {
        throw new PsycheError("invalid_params", `task ${p.taskId} is not a specialist's job`);
      }
      if (TERMINAL_TASK_STATUSES.includes(task.status)) {
        throw new PsycheError("conflict", `task ${p.taskId} is ${task.status}`);
      }
      if (p.budget === undefined && p.deadline === undefined) return { task };
      const role = (await deps.roles.specialistRoles()).find((r) => r.role.role === spec.role);
      if (role === undefined) {
        throw new PsycheError("unavailable", `the ${spec.role} role is not installed`);
      }
      const { caps } = role.role;
      let deadline: string | undefined;
      if (p.deadline !== undefined) {
        const at = Date.parse(p.deadline);
        if (!Number.isFinite(at) || at <= deps.now()) {
          throw new PsycheError("invalid_params", "deadline must be a future ISO-8601 time");
        }
        // No later than the role's maxHours after the job started, however often it is extended.
        const latest = Date.parse(task.createdAt) + caps.maxHours * 3_600_000;
        deadline = new Date(Math.min(at, latest)).toISOString();
      }
      // The runtime caps the limits by the role, writes them, and, for a job parked on its budget
      // question, answers "Give it more" so it re-queues without adding its own +50%.
      const updated = await deps.raise(p.taskId, {
        ...(p.budget?.tokens === undefined ? {} : { tokens: p.budget.tokens }),
        ...(p.budget?.costUsd === undefined ? {} : { costUsd: p.budget.costUsd }),
        ...(p.budget?.minutes === undefined ? {} : { minutes: p.budget.minutes }),
        ...(deadline === undefined ? {} : { deadline }),
      });
      await deps.tasks.addAction(p.taskId, {
        level1: p.budget === undefined ? "You gave it more time" : "You gave it more budget",
        level2: { tool: "task.update", outcome: "ok" },
      });
      deps.poke?.();
      return { task: updated };
    },
  };
}
