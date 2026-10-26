/**
 * drizzle mirrors of the S04 tables (`migrations/*_tasks_*.sql`, `*_scheduler_*.sql`). Owner:
 * S04 (`packages/tasks`, `packages/scheduler`). Same conventions as `schema.ts`.
 */
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  // 202610201700_tasks_taint_sources.sql
  taintSources: text("taint_sources"),
  // 202610231000_tasks_workspace.sql
  workspace: text("workspace"),
  // 202610261200_tasks_specialist.sql (S02, background specialists)
  specialist: text("specialist"),
  // 202610261301_tasks_lessons-applied.sql (teaching loop, LessonRef[] JSON)
  lessonsApplied: text("lessons_applied"),
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

// §8 Automations ------------------------------------------------------------------------------

export const automations = sqliteTable("automations", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  schedule: text("schedule").notNull(),
  timezone: text("timezone").notNull(),
  sessionTarget: text("session_target").notNull(),
  delivery: text("delivery").notNull(),
  prompt: text("prompt").notNull(),
  scratch: text("scratch"),
  enabled: integer("enabled").notNull(),
  lightContext: integer("light_context"),
  system: integer("system").notNull(),
  nextRunAt: text("next_run_at"),
  lastRunAt: text("last_run_at"),
  lastStatus: text("last_status"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // 202610252000_scheduler_event-triggers (S15 W3): the AutomationTrigger of `kind: event`.
  trigger: text("trigger"),
  // 202610262100_scheduler_automation-specialist (#683): run as a specialist job (§4.10).
  specialist: text("specialist"),
});

export const automationRuns = sqliteTable("automation_runs", {
  id: text("id").primaryKey(),
  automationId: text("automation_id").notNull(),
  threadId: text("thread_id"),
  taskId: text("task_id"),
  trigger: text("trigger").notNull(),
  scheduledFor: text("scheduled_for").notNull(),
  coalesced: integer("coalesced").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  status: text("status").notNull(),
  summary: text("summary"),
  notificationId: text("notification_id"),
  createdAt: text("created_at").notNull(),
  events: text("events"),
  // 202610261400_gateway_run-trace-automations: the agent run behind it and what it used.
  runId: text("run_id"),
  usage: text("usage"),
});

export const watches = sqliteTable("watches", {
  id: text("id").primaryKey(),
  automationId: text("automation_id").notNull(),
  url: text("url").notNull(),
  kind: text("kind").notNull(),
  selector: text("selector"),
  threshold: text("threshold"),
  lastValue: text("last_value"),
  alertedValue: text("alerted_value"),
  lastCheckedAt: text("last_checked_at"),
  failures: integer("failures").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Event triggers (202610252000_scheduler_event-triggers; S15 W3, #670).
export const automationEventSeen = sqliteTable(
  "automation_event_seen",
  {
    automationId: text("automation_id").notNull(),
    eventId: text("event_id").notNull(),
    seenAt: text("seen_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.automationId, t.eventId] })],
);

export const automationEventQueue = sqliteTable("automation_event_queue", {
  id: text("id").primaryKey(),
  automationId: text("automation_id").notNull(),
  event: text("event").notNull(),
  receivedAt: text("received_at").notNull(),
});

export const eventCursors = sqliteTable(
  "event_cursors",
  {
    source: text("source").notNull(),
    key: text("key").notNull(),
    cursor: text("cursor").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.key] })],
);

/** Every S04 table, merged into `schema` in `schema.ts`. */
export const s04Schema = {
  tasks,
  taskCheckpoints,
  taskActions,
  inputRequests,
  automations,
  automationRuns,
  watches,
  automationEventSeen,
  automationEventQueue,
  eventCursors,
};
