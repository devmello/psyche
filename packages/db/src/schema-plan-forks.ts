/**
 * drizzle mirror of the Fork a plan tables (migrations/202611241200_gateway_plan-forks.sql).
 * See the header of `schema.ts`: the SQL file owns constraints, indexes, triggers and defaults.
 */
import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// `id TEXT PRIMARY KEY` is nullable in SQLite, so `id` is a table-level key (no notNull).
export const planForks = sqliteTable(
  "plan_forks",
  {
    id: text("id"),
    threadId: text("thread_id").notNull(),
    forkMessageId: text("fork_message_id"),
    status: text("status").notNull(),
    error: text("error"),
    budgetUsd: real("budget_usd").notNull().default(1),
    spentUsd: real("spent_usd").notNull().default(0),
    tokens: integer("tokens").notNull().default(0),
    comparison: text("comparison"),
    takenBranchId: text("taken_branch_id"),
    takeApprovalId: text("take_approval_id"),
    createdByDeviceId: text("created_by_device_id"),
    expiresAt: text("expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);

export const planForkBranches = sqliteTable(
  "plan_fork_branches",
  {
    id: text("id"),
    forkId: text("fork_id").notNull(),
    ord: integer("ord").notNull(),
    label: text("label").notNull(),
    premise: text("premise").notNull(),
    threadId: text("thread_id").notNull(),
    taskId: text("task_id"),
    status: text("status").notNull().default("queued"),
    error: text("error"),
    report: text("report"),
    readOwnerOnly: integer("read_owner_only").notNull().default(0),
    taint: integer("taint").notNull().default(0),
    taintSources: text("taint_sources").notNull().default("[]"),
    spentUsd: real("spent_usd").notNull().default(0),
    tokens: integer("tokens").notNull().default(0),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);

export const planForksSchema = { planForks, planForkBranches };
