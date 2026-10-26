import type { Automation } from "../schemas/integrations.ts";

/**
 * Scheduler contract (architecture §4.11; owner S04). Automations with cron / interval
 * schedules, catch-up after sleep (missed ticks coalesced into one run), run-now, and the
 * unattended-run contract (the launched run is always `mode: "unattended"`).
 */

export type AutomationInput = Omit<
  Automation,
  "id" | "nextRunAt" | "lastRunAt" | "lastStatus" | "createdAt" | "updatedAt"
>;

/** `specialist: null` clears it (the automation runs as a plain Task again). */
export type AutomationPatch = Partial<Omit<AutomationInput, "specialist">> & {
  specialist?: AutomationInput["specialist"] | null;
};

export interface ScheduledRun {
  automationId: string;
  /** Epoch ms of the (latest) tick this run stands for. */
  scheduledFor: number;
  /** How many missed ticks were folded into this run (1 = on time). */
  coalesced: number;
  trigger: "schedule" | "manual";
}

export interface Scheduler {
  create(input: AutomationInput): Promise<Automation>;
  get(id: string): Promise<Automation | undefined>;
  list(): Promise<Automation[]>;
  update(id: string, patch: AutomationPatch): Promise<Automation>;
  remove(id: string): Promise<void>;
  /** The next `count` fire times (epoch ms) after `from` (default: now). */
  nextRuns(id: string, count: number, from?: number): Promise<number[]>;
  /** Fire everything due at `now` (default: clock now); one run per automation. */
  tick(now?: number): Promise<ScheduledRun[]>;
  runNow(id: string): Promise<ScheduledRun>;
}
