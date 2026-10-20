import type {
  ChecklistItem,
  InputRequest,
  JsonObject,
  Question,
  TaintSource,
  Task,
  TaskAction,
  TaskCheckpoint,
  TaskOrigin,
  TaskPlan,
  TaskStatus,
} from "@psyche/protocol";

/**
 * Raw better-sqlite3 rows of the S04 tables (migrations/202610191200_tasks_init.sql and
 * 202610201700_tasks_taint_sources.sql).
 */
export interface TaskRow {
  id: string;
  thread_id: string;
  title: string;
  goal: string;
  status: string;
  created_from: string;
  plan: string | null;
  checklist: string;
  current_step_id: string | null;
  attempt: number;
  lease_owner: string | null;
  lease_until: string | null;
  lease_token: string | null;
  run_mode: string;
  budget: string | null;
  resume: string;
  awaiting: string | null;
  browser_session_id: string | null;
  sandbox_id: string | null;
  summary: string | null;
  outcome: string | null;
  taint: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** JSON array of `TaintSource`; NULL when the creating turn was not tainted (design-08). */
  taint_sources: string | null;
  workspace: string | null;
}

export interface CheckpointRow {
  id: string;
  task_id: string;
  step_id: string;
  idx: number;
  replay_safe: number;
  status: string;
  payload: string | null;
  receipt_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActionRow {
  id: string;
  task_id: string;
  idx: number;
  tool_call_id: string | null;
  level1: string;
  level2: string;
  level3_ref: string | null;
  created_at: string;
}

export interface InputRow {
  id: string;
  task_id: string | null;
  thread_id: string;
  question: string;
  status: string;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
  answered_by_device_id: string | null;
}

export function parseJson<T>(text: string | null): T | null {
  return text === null ? null : (JSON.parse(text) as T);
}

export function json(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function taskFromRow(r: TaskRow): Task {
  const task: Task = {
    id: r.id,
    threadId: r.thread_id,
    title: r.title,
    goal: r.goal,
    status: r.status as TaskStatus,
    createdFrom: r.created_from as TaskOrigin,
    plan: parseJson<TaskPlan>(r.plan),
    checklist: parseJson<ChecklistItem[]>(r.checklist) ?? [],
    currentStepId: r.current_step_id,
    attempt: r.attempt,
    leaseOwner: r.lease_owner,
    leaseUntil: r.lease_until,
    browserSessionId: r.browser_session_id,
    sandboxId: r.sandbox_id,
    summary: r.summary,
    outcome: parseJson<JsonObject>(r.outcome),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
  if (r.taint !== null) task.taint = r.taint === 1;
  const sources = parseJson<TaintSource[]>(r.taint_sources);
  if (sources !== null) task.taintSources = sources;
  if (r.workspace === "sandbox" || r.workspace === "vm") task.workspace = r.workspace;
  return task;
}

export function checkpointFromRow(r: CheckpointRow): TaskCheckpoint {
  return {
    id: r.id,
    taskId: r.task_id,
    stepId: r.step_id,
    idx: r.idx,
    replaySafe: r.replay_safe === 1,
    status: r.status as TaskCheckpoint["status"],
    payload: parseJson<JsonObject>(r.payload),
    receiptId: r.receipt_id,
    createdAt: r.created_at,
  };
}

export function actionFromRow(r: ActionRow): TaskAction {
  return {
    id: r.id,
    taskId: r.task_id,
    idx: r.idx,
    toolCallId: r.tool_call_id,
    level1: r.level1,
    level2: JSON.parse(r.level2) as TaskAction["level2"],
    level3Ref: r.level3_ref,
    createdAt: r.created_at,
  };
}

export function inputFromRow(r: InputRow): InputRequest {
  return {
    id: r.id,
    taskId: r.task_id,
    threadId: r.thread_id,
    questions: parseJson<Question[]>(r.question) ?? [],
    status: r.status as InputRequest["status"],
    answer: parseJson<Record<string, string | string[]>>(r.answer),
    createdAt: r.created_at,
    answeredAt: r.answered_at,
    answeredByDeviceId: r.answered_by_device_id,
  };
}
