import type {
  Automation,
  AutomationRun,
  AutomationTrigger,
  WatchConfig,
  WorkflowEvent,
} from "@psyche/protocol";

/** Raw rows of the S04 scheduler tables (migrations/202610191300_scheduler_init.sql). */
export interface AutomationRow {
  id: string;
  kind: string;
  title: string;
  schedule: string;
  timezone: string;
  session_target: string;
  delivery: string;
  prompt: string;
  scratch: string | null;
  enabled: number;
  light_context: number | null;
  system: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  created_at: string;
  updated_at: string;
  /** 202610252000_scheduler_event-triggers: the trigger of `kind: event`. */
  trigger?: string | null;
  /** 202610262100_scheduler_automation-specialist: run each occurrence as a specialist job. */
  specialist?: string | null;
}

export interface RunRow {
  id: string;
  automation_id: string;
  thread_id: string | null;
  task_id: string | null;
  trigger: string;
  scheduled_for: string;
  coalesced: number;
  started_at: string;
  ended_at: string | null;
  status: string;
  summary: string | null;
  notification_id: string | null;
  created_at: string;
  /** The events an event run folded in (JSON array). */
  events?: string | null;
  /** Run trace: the agent run that did the work, and its usage (JSON). */
  run_id?: string | null;
  usage?: string | null;
}

export interface WatchRow {
  id: string;
  automation_id: string;
  url: string;
  kind: string;
  selector: string | null;
  threshold: string | null;
  last_value: string | null;
  alerted_value: string | null;
  last_checked_at: string | null;
  failures: number;
  created_at: string;
  updated_at: string;
}

export function watchConfigFromRow(w: WatchRow): WatchConfig {
  const extra = (w.threshold === null ? {} : JSON.parse(w.threshold)) as {
    threshold?: number;
    text?: string;
  };
  const config: WatchConfig = { url: w.url, check: w.kind as WatchConfig["check"] };
  if (w.selector !== null) config.selector = w.selector;
  if (extra.text !== undefined) config.text = extra.text;
  if (extra.threshold !== undefined) config.threshold = extra.threshold;
  return config;
}

export function automationFromRow(r: AutomationRow, w?: WatchRow): Automation {
  const a: Automation = {
    id: r.id,
    kind: r.kind as Automation["kind"],
    title: r.title,
    schedule: r.schedule,
    timezone: r.timezone,
    sessionTarget: r.session_target,
    delivery: JSON.parse(r.delivery) as Automation["delivery"],
    prompt: r.prompt,
    scratch: r.scratch,
    enabled: r.enabled === 1,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.light_context !== null) a.lightContext = r.light_context === 1;
  if (w !== undefined) a.watch = watchConfigFromRow(w);
  if (r.trigger != null) a.trigger = JSON.parse(r.trigger) as AutomationTrigger;
  if (r.specialist != null) a.specialist = JSON.parse(r.specialist) as Automation["specialist"];
  return a;
}

export function runFromRow(r: RunRow): AutomationRun {
  const run: AutomationRun = {
    id: r.id,
    automationId: r.automation_id,
    threadId: r.thread_id,
    taskId: r.task_id,
    trigger: r.trigger as AutomationRun["trigger"],
    scheduledFor: r.scheduled_for,
    coalesced: r.coalesced,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status as AutomationRun["status"],
    summary: r.summary,
    notificationId: r.notification_id,
  };
  if (r.events != null) run.events = JSON.parse(r.events) as WorkflowEvent[];
  if (r.run_id != null) run.runId = r.run_id;
  if (r.usage != null) run.usage = JSON.parse(r.usage) as NonNullable<AutomationRun["usage"]>;
  return run;
}
