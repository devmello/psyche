import type { PsycheDb } from "@psyche/db";
import type { PsycheNotifier } from "@psyche/notifications";
import {
  createGoalHandlers,
  GoalsService,
  HEARTBEAT_TASK_BUDGET,
  withProactiveJobs,
} from "@psyche/proactive";
import type { Clock, EventName, EventPayload } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import { createTaskLauncher, type RunLauncher, type SqliteScheduler } from "@psyche/scheduler";
import type { SqliteTaskEngine, TaskWorkerPool } from "@psyche/tasks";
import type { HandlerDef } from "../context.ts";
import type { Logger } from "../log.ts";
import { mountParamsOnly } from "./handlers.ts";

/**
 * Proactive surfaces (S15, feature O2 and O9 so far): goals with check-ins on the scheduler, and
 * the heartbeat on a launcher bounded by `HEARTBEAT_TASK_BUDGET` (under 5k tokens per run).
 * Check-in automations are recognised by their prompt marker and run in-process (no agent turn);
 * everything else reaches the agent launcher unchanged.
 */

export interface ProactiveSetup {
  db: PsycheDb;
  clock: Clock;
  scheduler: SqliteScheduler;
  notifier: PsycheNotifier;
  tasks: SqliteTaskEngine;
  publish<E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string): void;
  timeZone?: string;
  logger?: Logger;
}

export interface ComposedProactive {
  readonly goals: GoalsService;
  readonly handlers: Record<string, HandlerDef>;
  /** The scheduler's launcher: proactive jobs in-process, the heartbeat bounded, the rest to `inner`. */
  launcher(inner: RunLauncher, pool: TaskWorkerPool): RunLauncher;
  /** After the Gateway listens: re-create check-ins the scheduler lost, drop orphans. */
  start(): Promise<void>;
}

export function composeProactive(setup: ProactiveSetup): ComposedProactive {
  const { db, clock, scheduler, notifier, tasks, publish, timeZone, logger } = setup;
  const goals = new GoalsService({
    db: db.sqlite,
    clock,
    scheduler,
    notifier,
    tasks,
    ...(timeZone === undefined ? {} : { timezone: timeZone }),
    onEvent: (e) => publish(e.event, e.payload),
  });
  return {
    goals,
    handlers: mountParamsOnly(createGoalHandlers(goals) as never),
    launcher: (inner, pool) =>
      withProactiveJobs(inner, {
        jobs: [goals.checkinJob()],
        heartbeat: createTaskLauncher({ engine: tasks, pool, budget: HEARTBEAT_TASK_BUDGET }),
        onError: (err) =>
          logger?.log("warn", "proactive job failed", { code: PsycheError.from(err).code }),
      }),
    async start() {
      try {
        await goals.start();
      } catch (err) {
        logger?.log("warn", "goal check-in sync failed", { code: PsycheError.from(err).code });
      }
    },
  };
}
