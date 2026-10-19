import { NotImplementedError, type Scheduler } from "@psyche/protocol";

/**
 * Placeholder for the `Scheduler` implementation owned by S04.
 * Build against `FakeScheduler` from `@psyche/testing` until this lands.
 */
export function createScheduler(): Scheduler {
  throw new NotImplementedError("@psyche/scheduler", "createScheduler");
}
