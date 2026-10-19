import { type MethodParams, type MethodResult, PsycheError } from "@psyche/protocol";
import type { SqliteScheduler } from "./scheduler.ts";

type AutomationMethod =
  | "automations.list"
  | "automations.create"
  | "automations.update"
  | "automations.delete"
  | "automations.run"
  | "automations.runs"
  | "automations.upcoming";

export type AutomationHandlers = {
  [M in AutomationMethod]: (params: MethodParams<M>) => Promise<MethodResult<M>>;
};

/** `automations.*` handlers for the Gateway to mount (S01 validates params and scopes first). */
export function createAutomationHandlers(scheduler: SqliteScheduler): AutomationHandlers {
  const strip = <T extends Record<string, unknown>>(o: T): Partial<T> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
  return {
    "automations.list": async (p) => ({
      automations: await scheduler.list(p.kind === undefined ? {} : { kind: p.kind }),
    }),
    "automations.create": async (p) => ({
      automation: await scheduler.create({
        ...strip(p),
        kind: p.kind,
        title: p.title,
        schedule: p.schedule,
        prompt: p.prompt,
      }),
    }),
    "automations.update": async ({ automationId, ...patch }) => ({
      automation: await scheduler.update(automationId, strip(patch)),
    }),
    "automations.delete": async (p) => {
      const a = await scheduler.get(p.automationId);
      if (a === undefined) throw new PsycheError("not_found", "automation not found");
      await scheduler.remove(p.automationId);
      return { ok: true as const };
    },
    "automations.run": async (p) => {
      const { run, taskId } = await scheduler.trigger(p.automationId);
      return { runId: run.id, taskId };
    },
    "automations.runs": async (p) =>
      scheduler.runs(p.automationId, {
        ...(p.cursor === undefined ? {} : { cursor: p.cursor }),
        ...(p.limit === undefined ? {} : { limit: p.limit }),
      }),
    "automations.upcoming": async (p) => ({
      items: scheduler.upcoming({
        ...(p.horizonHours === undefined ? {} : { horizonMs: p.horizonHours * 3_600_000 }),
        ...(p.limit === undefined ? {} : { limit: p.limit }),
      }),
    }),
  };
}
