import type {
  Automation,
  AutomationRun,
  InputRequest,
  TaintSource,
  WorkflowEvent,
} from "@psyche/protocol";

/** What a launched automation run produced (the unattended-run contract's outcomes). */
export interface RunResult {
  status: "done" | "no_reply" | "failed" | "cancelled";
  /** The deliverable (final message) or the failure reason. */
  summary: string | null;
  taskId?: string;
}

export interface AutomationRunRequest {
  automation: Automation;
  run: AutomationRun;
  /** Resolved from the session target. */
  threadId: string;
  /** The prompt with the unattended-run contract, scratch note and catch-up note. */
  prompt: string;
  /** Heartbeat: skip workspace bootstrap files. */
  lightContext: boolean;
  /** Event runs: the events folded into this run (their sender and subject are untrusted). */
  events?: WorkflowEvent[];
  /** Event runs: the taint the events carry (mail senders, invitations, recordings). */
  taintSources?: TaintSource[];
}

export interface LaunchedRun {
  taskId?: string;
  result: Promise<RunResult>;
}

/** Starts the agent for a run. The default (`createTaskLauncher`) runs it as an unattended Task. */
export interface RunLauncher {
  launch(request: AutomationRunRequest): Promise<LaunchedRun>;
  /** After a restart: follow a run that was still `running` (its task may still be alive). */
  reattach?(run: AutomationRun): Promise<RunResult> | undefined;
  /** Stop a run (its automation was deleted). */
  cancel?(run: AutomationRun, reason: string): Promise<void>;
}

/** `main | isolated | named:<id>` → a thread id (architecture §4.11; OpenClaw session targets). */
export interface SessionResolver {
  resolve(target: string, context: { automation: Automation; runId: string }): Promise<string>;
}

export interface DeliveryReceipt {
  notificationId?: string;
}

/** Where a finished run's deliverable goes (thread, channel, webhook, none). */
export interface Deliverer {
  deliver(automation: Automation, run: AutomationRun, result: RunResult): Promise<DeliveryReceipt>;
}

/** Injected by the connectors package: fetches a public page with its SSRF policy and size caps. */
export type WatchFetch = (
  url: string,
  options: { signal?: AbortSignal },
) => Promise<{ status: number; text: string }>;

export type SchedulerEvent =
  | { event: "automation.updated"; payload: { automation: Automation }; stateVersion: number }
  | { event: "automation.run.started"; payload: { run: AutomationRun }; stateVersion: number }
  | { event: "automation.run.finished"; payload: { run: AutomationRun }; stateVersion: number };

export type SchedulerEventListener = (event: SchedulerEvent) => void;

/** Open input requests shown at the end of Upcoming (architecture §4.5). */
export type OpenInputRequests = () => InputRequest[];
