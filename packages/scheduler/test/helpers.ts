import { openDb, type PsycheDb } from "@psyche/db";
import type { Clock } from "@psyche/protocol";
import type { Timers } from "@psyche/tasks";
import { createIdGenerator, FakeClock, FakeNotifier } from "@psyche/testing";
import {
  type AutomationRunRequest,
  createDbSessionResolver,
  createDeliverer,
  type DelivererOptions,
  type RunLauncher,
  type RunResult,
  SqliteScheduler,
  type SqliteSchedulerOptions,
} from "../src/index.ts";

export function testDb(clock: Clock): PsycheDb {
  const ids = createIdGenerator({ prefix: "db" });
  return openDb(":memory:", {
    now: () => new Date(clock.now()).toISOString(),
    newId: () => ids.next(),
  });
}

export function clockTimers(clock: FakeClock): Timers {
  return {
    setTimeout: (fn, ms) => clock.setTimer(clock.now() + ms, fn),
    clearTimeout: (h) => (h as (() => void) | undefined)?.(),
  };
}

/** Timers that never fire: the machine is asleep. */
export const asleep: Timers = { setTimeout: () => undefined, clearTimeout: () => {} };

/** A launcher that records requests and answers each with `respond` (default: done). */
export class RecordingLauncher implements RunLauncher {
  readonly requests: AutomationRunRequest[] = [];
  respond: (r: AutomationRunRequest) => RunResult | Promise<RunResult> = (r) => ({
    status: "done",
    summary: `Result of ${r.automation.title}`,
  });
  async launch(request: AutomationRunRequest) {
    this.requests.push(request);
    return {
      taskId: `task_${this.requests.length}`,
      result: Promise.resolve(this.respond(request)),
    };
  }
}

export function setup(
  options: {
    start?: number;
    timers?: Timers;
    deliverer?: Partial<DelivererOptions>;
  } & Omit<Partial<SqliteSchedulerOptions>, "deliverer"> = {},
) {
  const { deliverer, start, timers, ...rest } = options;
  const clock = new FakeClock(start);
  const db = options.db ?? testDb(clock);
  const notifier = new FakeNotifier({ clock });
  const launcher = new RecordingLauncher();
  const ids = createIdGenerator({ prefix: "s" });
  const channelSends: { channelId: string; text: string }[] = [];
  const scheduler = new SqliteScheduler({
    db,
    clock,
    timers: timers ?? clockTimers(clock),
    newId: () => ids.next(),
    launcher,
    sessions: createDbSessionResolver(db),
    notifier,
    deliverer: createDeliverer({
      notifier,
      sendToChannel: async (channelId, text) => {
        channelSends.push({ channelId, text });
      },
      ...deliverer,
    }),
    ...rest,
  });
  return { clock, db, notifier, launcher, scheduler, channelSends };
}

export const BASE = {
  title: "Inbox triage",
  prompt: "Triage my inbox",
  timezone: "UTC",
  sessionTarget: "isolated",
  delivery: {},
  scratch: null,
  enabled: true,
};
