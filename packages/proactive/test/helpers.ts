import { openDb, type PsycheDb } from "@psyche/db";
import type { Clock } from "@psyche/protocol";
import {
  type AutomationRunRequest,
  createDbSessionResolver,
  type RunLauncher,
  type RunResult,
  SqliteScheduler,
} from "@psyche/scheduler";
import type { Timers } from "@psyche/tasks";
import { createIdGenerator, FakeClock, FakeNotifier, FakeTaskEngine } from "@psyche/testing";
import { type GoalEvent, GoalsService, withProactiveJobs } from "../src/index.ts";

export const T0 = Date.parse("2026-10-19T09:00:00Z");

export function testDb(clock: Clock): PsycheDb {
  const ids = createIdGenerator({ prefix: "db" });
  return openDb(":memory:", {
    now: () => new Date(clock.now()).toISOString(),
    newId: () => ids.next(),
  });
}

/** Timers that never fire: runs are driven by `trigger` / `tick`. */
export const asleep: Timers = { setTimeout: () => undefined, clearTimeout: () => {} };

/** The agent launcher every non-proactive automation would reach; records requests. */
export class RecordingLauncher implements RunLauncher {
  readonly requests: AutomationRunRequest[] = [];
  respond: (r: AutomationRunRequest) => RunResult = (r) => ({
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

/** A real `SqliteScheduler` on an in-memory db with the goals service wired through it. */
export function setup(options: { start?: number } = {}) {
  const clock = new FakeClock(options.start ?? T0);
  const db = testDb(clock);
  const notifier = new FakeNotifier({ clock });
  const tasks = new FakeTaskEngine({ clock });
  const agent = new RecordingLauncher();
  const ids = createIdGenerator({ prefix: "s" });
  const events: GoalEvent[] = [];
  // scheduler ↔ goals: the launcher needs the service, the service needs the scheduler.
  let goals: GoalsService | null = null;
  const scheduler = new SqliteScheduler({
    db,
    clock,
    timers: asleep,
    newId: () => ids.next(),
    launcher: withProactiveJobs(agent, {
      get jobs() {
        return goals === null ? [] : [goals.checkinJob()];
      },
    }),
    sessions: createDbSessionResolver(db),
    notifier,
  });
  goals = new GoalsService({
    db: db.sqlite,
    clock,
    scheduler,
    notifier,
    tasks,
    newId: () => ids.next("goal"),
    timezone: "UTC",
    onEvent: (e) => events.push(e),
  });
  return { clock, db, notifier, tasks, agent, scheduler, goals, events };
}
