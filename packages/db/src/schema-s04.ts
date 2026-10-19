/**
 * drizzle mirrors of the S04 tables (`migrations/*_tasks_*.sql`, `*_scheduler_*.sql`). Owner:
 * S04 (`packages/tasks`, `packages/scheduler`). Same conventions as `schema.ts`.
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// §3 Tasks -----------------------------------------------------------------------------------

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  title: text("title").notNull(),
  goal: text("goal").notNull(),
  status: text("status").notNull(),
  createdFrom: text("created_from").notNull(),
  plan: text("plan"),
  checklist: text("checklist").notNull(),
  currentStepId: text("current_step_id"),
  attempt: integer("attempt").notNull(),
  leaseOwner: text("lease_owner"),
  leaseUntil: text("lease_until"),
  leaseToken: text("lease_token"),
  runMode: text("run_mode").notNull(),
  budget: text("budget"),
  resume: text("resume").notNull(),
  awaiting: text("awaiting"),
  browserSessionId: text("browser_session_id"),
  sandboxId: text("sandbox_id"),
  summary: text("summary"),
  outcome: text("outcome"),
  taint: integer("taint"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
});

export const taskCheckpoints = sqliteTable("task_checkpoints", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  stepId: text("step_id").notNull(),
  idx: integer("idx").notNull(),
  replaySafe: integer("replay_safe").notNull(),
  status: text("status").notNull(),
  payload: text("payload"),
  receiptId: text("receipt_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const taskActions = sqliteTable("task_actions", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  idx: integer("idx").notNull(),
  toolCallId: text("tool_call_id"),
  level1: text("level1").notNull(),
  level2: text("level2").notNull(),
  level3Ref: text("level3_ref"),
  createdAt: text("created_at").notNull(),
});

export const inputRequests = sqliteTable("input_requests", {
  id: text("id").primaryKey(),
  taskId: text("task_id"),
  threadId: text("thread_id").notNull(),
  question: text("question").notNull(),
  status: text("status").notNull(),
  answer: text("answer"),
  createdAt: text("created_at").notNull(),
  answeredAt: text("answered_at"),
  answeredByDeviceId: text("answered_by_device_id"),
});

/** Every S04 table, merged into `schema` in `schema.ts`. */
export const s04Schema = { tasks, taskCheckpoints, taskActions, inputRequests };
