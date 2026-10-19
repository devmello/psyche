import { NotImplementedError, type TaskEngine } from "@psyche/protocol";

/**
 * Placeholder for the `TaskEngine` implementation owned by S04.
 * Build against `FakeTaskEngine` from `@psyche/testing` until this lands.
 */
export function createTaskEngine(): TaskEngine {
  throw new NotImplementedError("@psyche/tasks", "createTaskEngine");
}
