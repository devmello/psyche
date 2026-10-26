import {
  type MethodParams,
  type MethodResult,
  PsycheError,
  type RunBudget,
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
  /** Woken after a change, so a job that waits on its budget can go on. */
  poke?: () => void;
}

const capAt = (value: number, cap: number | undefined) =>
  cap === undefined ? value : Math.min(value, cap);

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
      const limit: RunBudget["limit"] = { ...spec.budget.limit };
      if (p.budget?.tokens !== undefined) limit.tokens = capAt(p.budget.tokens, caps.tokens);
      if (p.budget?.costUsd !== undefined) limit.costUsd = capAt(p.budget.costUsd, caps.costUsd);
      if (p.budget?.minutes !== undefined) {
        limit.wallMs = capAt(p.budget.minutes, caps.minutes) * 60_000;
      }
      let deadline = spec.deadline;
      if (p.deadline !== undefined) {
        const at = Date.parse(p.deadline);
        if (!Number.isFinite(at) || at <= deps.now()) {
          throw new PsycheError("invalid_params", "deadline must be a future ISO-8601 time");
        }
        // No later than the role's maxHours after the job started, however often it is extended.
        const latest = Date.parse(task.createdAt) + caps.maxHours * 3_600_000;
        deadline = new Date(Math.min(at, latest)).toISOString();
      }
      const updated = await deps.tasks.updateSpecialist(p.taskId, (s) => ({
        ...s,
        budget: { ...s.budget, limit },
        deadline,
      }));
      await deps.tasks.addAction(p.taskId, {
        level1: p.budget === undefined ? "You gave it more time" : "You gave it more budget",
        level2: { tool: "task.update", outcome: "ok" },
      });
      deps.poke?.();
      return { task: updated };
    },
  };
}
