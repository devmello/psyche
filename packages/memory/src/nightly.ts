import type { Automation, AutomationInput, AutomationPatch } from "@psyche/protocol";
import { DREAMING_PROMPT_MARKER, type DreamingOptions, runDreaming } from "./dreaming.ts";
import type { SqliteMemoryStore } from "./store.ts";

/**
 * Nightly dreaming through `@psyche/scheduler` (S04). The scheduler owns timing, catch-up after
 * sleep (missed nights fold into one run) and run history; this module supplies:
 *
 * - `ensureDreamingAutomation(scheduler)`: one system automation, `0 3 * * *` in the owner's
 *   zone, recognised by its prompt marker. Re-running it updates the schedule in place.
 * - `withDreaming(store, launcher)`: wraps the scheduler's `RunLauncher` so that automation runs
 *   in-process (no agent turn, no thread messages) and every other automation goes to the
 *   wrapped launcher. A successful run reports `no_reply`, so nothing is delivered; a failure
 *   reaches the owner as the scheduler's usual `task_failed` notification.
 *
 * The types below are structural copies of the scheduler's, so this package does not depend on
 * it.
 */

export const DREAMING_SCHEDULE = "0 3 * * *";

export interface LaunchResult {
  status: "done" | "no_reply" | "failed" | "cancelled";
  summary: string | null;
  taskId?: string;
}

export interface LaunchRequest {
  automation: Automation;
  run: { id: string };
  threadId: string;
  prompt: string;
  lightContext: boolean;
}

export interface Launcher<R = LaunchRequest, Run = unknown> {
  launch(request: R): Promise<{ taskId?: string; result: Promise<LaunchResult> }>;
  reattach?(run: Run): Promise<LaunchResult> | undefined;
  cancel?(run: Run, reason: string): Promise<void>;
}

export interface SchedulerLike {
  list(): Promise<Automation[]>;
  create(input: AutomationInput & { system?: boolean }): Promise<Automation>;
  update(id: string, patch: AutomationPatch): Promise<Automation>;
}

export function isDreamingAutomation(automation: Pick<Automation, "prompt">): boolean {
  return automation.prompt.trim() === DREAMING_PROMPT_MARKER;
}

/** Creates or updates the nightly dreaming automation. */
export async function ensureDreamingAutomation(
  scheduler: SchedulerLike,
  options: { timezone: string; enabled?: boolean },
): Promise<Automation> {
  const fields = {
    title: "Memory dreaming",
    schedule: DREAMING_SCHEDULE,
    timezone: options.timezone,
    sessionTarget: "main",
    delivery: {},
    prompt: DREAMING_PROMPT_MARKER,
    enabled: options.enabled ?? true,
  };
  const existing = (await scheduler.list()).find(isDreamingAutomation);
  if (existing !== undefined) return scheduler.update(existing.id, fields);
  return scheduler.create({ kind: "cron", scratch: null, system: true, ...fields });
}

/** Runs dreaming for its automation and passes every other run to `inner`. */
export function withDreaming<R extends LaunchRequest, Run>(
  store: SqliteMemoryStore,
  inner: Launcher<R, Run>,
  options: DreamingOptions = {},
): Launcher<R, Run> {
  return {
    async launch(request) {
      if (!isDreamingAutomation(request.automation)) return inner.launch(request);
      const result = runDreaming(store, options).then(
        (r): LaunchResult => ({
          status: "no_reply",
          summary: `promoted ${r.promoted}, merged ${r.merged}, superseded ${r.superseded}, dropped ${r.dropped}`,
        }),
        (): LaunchResult => ({ status: "failed", summary: "Memory dreaming failed" }),
      );
      return { result };
    },
    ...(inner.reattach === undefined ? {} : { reattach: (run: Run) => inner.reattach?.(run) }),
    ...(inner.cancel === undefined
      ? {}
      : { cancel: (run: Run, reason: string) => inner.cancel?.(run, reason) ?? Promise.resolve() }),
  };
}
