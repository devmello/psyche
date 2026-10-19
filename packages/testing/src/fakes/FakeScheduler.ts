import type {
  Automation,
  AutomationInput,
  AutomationPatch,
  Clock,
  ScheduledRun,
  Scheduler,
} from "@psyche/protocol";
import { FakeClock, toIso } from "../clock.ts";
import { createIdGenerator, type IdGenerator } from "../ids.ts";
import { fail } from "./errors.ts";

const MINUTE = 60_000;

/** ISO-8601 duration subset: `PnD`, `PTnHnMnS`, `PnDTnHnMnS`. */
export function parseIsoDuration(text: string): number | undefined {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text);
  if (m === null || text === "P" || text === "PT") return undefined;
  const [d, h, mi, s] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0)) as [
    number,
    number,
    number,
    number,
  ];
  const ms = ((d * 24 + h) * 60 + mi) * MINUTE + s * 1000;
  return ms > 0 ? ms : undefined;
}

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  const step = /^\*\/(\d+)$/.exec(field);
  if (step !== null) return value % Number(step[1]) === 0;
  return field.split(",").some((f) => Number(f) === value);
}

/**
 * Next fire time strictly after `after` for a 5-field cron expression, evaluated in UTC.
 * Supports `*`, `*\/N`, numbers and comma lists in every field (fake-grade, not cron-parser).
 */
export function nextCron(expr: string, after: number): number {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) fail("invalid_params", `cron needs 5 fields: ${expr}`);
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  let t = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  for (let i = 0; i < 366 * 24 * 60; i += 1, t += MINUTE) {
    const d = new Date(t);
    if (
      fieldMatches(min, d.getUTCMinutes()) &&
      fieldMatches(hour, d.getUTCHours()) &&
      fieldMatches(dom, d.getUTCDate()) &&
      fieldMatches(mon, d.getUTCMonth() + 1) &&
      fieldMatches(dow, d.getUTCDay())
    ) {
      return t;
    }
  }
  return fail("invalid_params", `cron never fires: ${expr}`);
}

export interface FakeSchedulerOptions {
  clock?: Clock;
  ids?: IdGenerator;
}

/**
 * In-memory scheduler (architecture §4.11). `interval` / `heartbeat` / `watch` automations use
 * ISO-8601 durations; `cron` / `briefing` use 5-field cron in UTC (timezones are ignored by the
 * fake). Missed ticks are coalesced into one run. Every run is recorded in `runs`.
 */
export class FakeScheduler implements Scheduler {
  readonly clock: Clock;
  readonly runs: ScheduledRun[] = [];
  #ids: IdGenerator;
  #items = new Map<string, Automation>();

  constructor(options: FakeSchedulerOptions = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.#ids = options.ids ?? createIdGenerator();
  }

  #next(a: Pick<Automation, "kind" | "schedule">, after: number): number {
    if (a.kind === "cron" || a.kind === "briefing") return nextCron(a.schedule, after);
    const ms = parseIsoDuration(a.schedule);
    if (ms === undefined) return fail("invalid_params", `bad duration: ${a.schedule}`);
    return after + ms;
  }

  #get(id: string): Automation {
    const a = this.#items.get(id);
    if (a === undefined) return fail("not_found", `automation ${id} not found`);
    return a;
  }

  async create(input: AutomationInput): Promise<Automation> {
    const now = this.clock.now();
    const a: Automation = {
      ...structuredClone(input),
      id: this.#ids.next("auto"),
      nextRunAt: input.enabled ? toIso(this.#next(input, now)) : null,
      lastRunAt: null,
      lastStatus: null,
      createdAt: toIso(now),
      updatedAt: toIso(now),
    };
    this.#items.set(a.id, a);
    return structuredClone(a);
  }

  async get(id: string): Promise<Automation | undefined> {
    const a = this.#items.get(id);
    return a === undefined ? undefined : structuredClone(a);
  }

  async list(): Promise<Automation[]> {
    return [...this.#items.values()].map((a) => structuredClone(a));
  }

  async update(id: string, patch: AutomationPatch): Promise<Automation> {
    const a = this.#get(id);
    Object.assign(a, structuredClone(patch));
    const now = this.clock.now();
    a.updatedAt = toIso(now);
    a.nextRunAt = a.enabled ? toIso(this.#next(a, now)) : null;
    return structuredClone(a);
  }

  async remove(id: string): Promise<void> {
    this.#get(id);
    this.#items.delete(id);
  }

  async nextRuns(id: string, count: number, from?: number): Promise<number[]> {
    const a = this.#get(id);
    const out: number[] = [];
    let t = from ?? this.clock.now();
    for (let i = 0; i < count; i += 1) {
      t = this.#next(a, t);
      out.push(t);
    }
    return out;
  }

  async tick(now: number = this.clock.now()): Promise<ScheduledRun[]> {
    const fired: ScheduledRun[] = [];
    for (const a of this.#items.values()) {
      if (!a.enabled || a.nextRunAt == null) continue;
      let due = Date.parse(a.nextRunAt);
      if (due > now) continue;
      let coalesced = 0;
      let latest = due;
      while (due <= now) {
        coalesced += 1;
        latest = due;
        due = this.#next(a, due);
      }
      const run: ScheduledRun = {
        automationId: a.id,
        scheduledFor: latest,
        coalesced,
        trigger: "schedule",
      };
      a.lastRunAt = toIso(now);
      a.lastStatus = "started";
      a.nextRunAt = toIso(due);
      fired.push(run);
      this.runs.push(run);
    }
    return fired;
  }

  async runNow(id: string): Promise<ScheduledRun> {
    const a = this.#get(id);
    const now = this.clock.now();
    a.lastRunAt = toIso(now);
    a.lastStatus = "started";
    const run: ScheduledRun = {
      automationId: id,
      scheduledFor: now,
      coalesced: 1,
      trigger: "manual",
    };
    this.runs.push(run);
    return run;
  }
}
