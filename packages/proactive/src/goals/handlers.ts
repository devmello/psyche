import type { MethodParams, MethodResult } from "@psyche/protocol";
import type { GoalsService } from "./service.ts";

type GoalMethod =
  | "goals.list"
  | "goals.get"
  | "goals.decide"
  | "goals.create"
  | "goals.update"
  | "goals.archive"
  | "goals.milestone"
  | "goals.link";

export type GoalHandlers = {
  [M in GoalMethod]: (params: MethodParams<M>) => Promise<MethodResult<M>>;
};

const strip = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** `goals.*` handlers for the Gateway (params validated and scopes checked by the router). */
export function createGoalHandlers(goals: GoalsService): GoalHandlers {
  return {
    "goals.list": async (p) => ({ goals: await goals.list(strip(p)) }),
    "goals.get": (p) => goals.get(p.goalId),
    "goals.decide": async (p) => ({ goal: await goals.decide(p.goalId, p.decision) }),
    "goals.create": (p) => goals.create(strip(p)),
    "goals.update": ({ goalId, ...patch }) => goals.update(goalId, strip(patch)),
    "goals.archive": async (p) => ({ goal: await goals.archive(p.goalId) }),
    "goals.milestone": (p) => goals.milestone(strip(p)),
    "goals.link": async (p) => {
      await goals.link(strip(p));
      return { ok: true as const };
    },
  };
}
