/**
 * drizzle mirror of the Night shift tables (migrations/202611241000_proactive_night-shift.sql).
 * See the header of `schema.ts`: the SQL file owns constraints, indexes and defaults.
 */
import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// `id TEXT PRIMARY KEY` is nullable in SQLite, so `id` is a table-level key (no notNull).
export const nightShiftNights = sqliteTable(
  "night_shift_nights",
  {
    id: text("id"),
    night: text("night").notNull(),
    status: text("status").notNull(),
    stopReason: text("stop_reason"),
    candidates: text("candidates"),
    spentUsd: real("spent_usd").notNull().default(0),
    tokens: integer("tokens").notNull().default(0),
    reviewStatus: text("review_status").notNull().default("none"),
    expiresAt: text("expires_at"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);

export const stagedActions = sqliteTable(
  "staged_actions",
  {
    id: text("id"),
    nightId: text("night_id"),
    forkBranchId: text("fork_branch_id"),
    seq: integer("seq").notNull(),
    domain: text("domain").notNull(),
    targetKey: text("target_key").notNull(),
    tool: text("tool").notNull(),
    kind: text("kind").notNull(),
    sideEffect: text("side_effect").notNull(),
    target: text("target"),
    params: text("params"),
    paramsHash: text("params_hash").notNull(),
    bindingHash: text("binding_hash").notNull(),
    summary: text("summary").notNull(),
    preview: text("preview"),
    why: text("why"),
    precondition: text("precondition"),
    inverse: text("inverse"),
    send: text("send"),
    taint: integer("taint").notNull().default(0),
    taintSources: text("taint_sources").notNull().default("[]"),
    status: text("status").notNull().default("ready"),
    result: text("result"),
    approvalId: text("approval_id"),
    taskId: text("task_id"),
    toolCallId: text("tool_call_id"),
    appliedAt: text("applied_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);

export const nightShiftSchema = { nightShiftNights, stagedActions };
