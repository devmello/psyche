import { type MethodParams, type MethodResult, PsycheError } from "@psyche/protocol";
import type { SqliteScheduler } from "./scheduler.ts";

type AutomationMethod =
  | "automations.list"
  | "automations.create"
  | "automations.update"
  | "automations.delete"
  | "automations.run"
  | "automations.cancelRetry"
  | "automations.runs"
  | "automations.upcoming";

export type AutomationHandlers = {
  [M in AutomationMethod]: (params: MethodParams<M>) => Promise<MethodResult<M>>;
};

const AGENT_RUN_WAIT_MS = 1_500;
const AGENT_RUN_POLL_MS = 25;

async function agentRunIdOf(scheduler: SqliteScheduler, automationRunId: string, waitMs: number) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { agentRunId, ended } = scheduler.agentRunOf(automationRunId);
    if (agentRunId !== null) return agentRunId;
    if (ended || Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, AGENT_RUN_POLL_MS));
  }
}

/** `automations.*` handlers for the Gateway to mount (S01 validates params and scopes first). */
export function createAutomationHandlers(
  scheduler: SqliteScheduler,
  options: { agentRunWaitMs?: number } = {},
): AutomationHandlers {
  const strip = <T extends Record<string, unknown>>(o: T): Partial<T> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
  return {
    "automations.list": async (p) => ({
      automations: await scheduler.list(p.kind === undefined ? {} : { kind: p.kind }),
    }),
    "automations.create": async (p) => {
      if (/^\s*(\[psyche|@psyche\/)/i.test(p.prompt)) {
        throw new PsycheError(
          "invalid_params",
          "that prompt is reserved for Psyche's own routines",
        );
      }
      return {
        automation: await scheduler.create({
          // The recorded-skill marker is set only by the owner's own action (skills.recording.schedule).
          ...strip({ ...p, recordedSkill: undefined }),
          kind: p.kind,
          title: p.title,
          schedule: p.schedule,
          prompt: p.prompt,
        }),
      };
    },
    "automations.update": async ({ automationId, ...patch }) => ({
      automation: await scheduler.update(
        automationId,
        strip({ ...patch, recordedSkill: undefined }),
      ),
    }),
    "automations.delete": async (p) => {
      const a = await scheduler.get(p.automationId);
      if (a === undefined) throw new PsycheError("not_found", "automation not found");
      // Psyche's own routines are paused, not deleted: their owner re-creates them at start.
      if (scheduler.systemIds().has(a.id)) {
        throw new PsycheError("policy_denied", "a built-in routine can be paused, not deleted");
      }
      await scheduler.remove(p.automationId);
      return { ok: true as const };
    },
    "automations.run": async (p) => {
      const { run, taskId } = await scheduler.trigger(p.automationId);
      // `runId` is the agent run (what `runs.get` and `runs.steps` open), not the automation run's
      // own id. The task's first turn creates it a moment after launch, so wait briefly for it.
      return {
        runId: await agentRunIdOf(scheduler, run.id, options.agentRunWaitMs ?? AGENT_RUN_WAIT_MS),
        taskId,
      };
    },
    "automations.cancelRetry": async (p) => ({ run: await scheduler.cancelRetry(p.runId) }),
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
