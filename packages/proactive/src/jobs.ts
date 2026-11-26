import type { Automation, AutomationInput, AutomationPatch } from "@psyche/protocol";

/**
 * Proactive jobs through `@psyche/scheduler` (S04). The scheduler owns timing, catch-up after
 * sleep and run history; this module wraps its `RunLauncher` (S07's `withDreaming` pattern) so
 * that system automations recognised by a prompt marker run in-process, without an agent turn,
 * and every other automation goes to the wrapped launcher. The heartbeat (O2) goes to its own
 * launcher, created with `HEARTBEAT_TASK_BUDGET`.
 *
 * The types are structural copies of the scheduler's, so this package does not depend on it.
 */

export interface LaunchResult {
  status: "done" | "no_reply" | "failed" | "cancelled";
  summary: string | null;
  taskId?: string;
  /** True when the job failed before it did anything visible, so a retry is safe. */
  noSideEffects?: boolean;
  /** The error's own message, kept apart from `summary` (which the owner sees). */
  errorDetail?: string;
}

/**
 * Thrown by a job that failed before its first side effect (it had only read things). The
 * launcher reports `noSideEffects`, so the scheduler's 1/5/15 minute retry applies to a
 * transient provider error. The message of `cause` rides along as `errorDetail`.
 */
export class BeforeEffectError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "BeforeEffectError";
  }
}

export interface LaunchRequest {
  automation: Automation;
  run: { id: string; scheduledFor: string; coalesced: number };
  threadId: string;
  prompt: string;
  lightContext: boolean;
}

export interface Launcher<R extends LaunchRequest = LaunchRequest, Run = unknown> {
  launch(request: R): Promise<{ taskId?: string; result: Promise<LaunchResult> }>;
  reattach?(run: Run): Promise<LaunchResult> | undefined;
  cancel?(run: Run, reason: string): Promise<void>;
  /** After a restart cut off a run with nothing to follow: may it run again? Default no. */
  rerunOnInterrupt?(automation: Automation): boolean;
}

/** What this package needs from the scheduler (`SqliteScheduler` and `FakeScheduler` both fit). */
export interface SchedulerLike {
  list(): Promise<Automation[]>;
  get(id: string): Promise<Automation | undefined>;
  create(input: AutomationInput & { system?: boolean }): Promise<Automation>;
  update(id: string, patch: AutomationPatch): Promise<Automation>;
  remove(id: string): Promise<void>;
}

/** One in-process job: `matches` by the automation's prompt marker, `run` returns the outcome. */
export interface ProactiveJob {
  readonly name: string;
  /**
   * Set only for a job that reads and proposes (cards, notices, approvals) and never acts on its
   * own: a restart that cut a scheduled run short then runs it again once. Unset, the owner is
   * told it was interrupted instead.
   */
  readonly rerunOnInterrupt?: boolean;
  matches(automation: Pick<Automation, "prompt" | "kind">): boolean;
  run(request: LaunchRequest): Promise<LaunchResult>;
}

/** `[psyche:<job> <arg>]`: the prompt of a system automation this package owns. */
export function jobMarker(job: string, arg: string): string {
  return `[psyche:${job} ${arg}]`;
}

/**
 * Parses a job marker; `undefined` for any other prompt. The marker is the first line; the
 * lines after it (`rest`) are the job's own text, for example a briefing's instructions.
 */
export function parseJobMarker(
  prompt: string,
): { job: string; arg: string; rest: string } | undefined {
  const [first = "", ...others] = prompt.trim().split("\n");
  const m = /^\[psyche:([a-z-]+) ([^\]\s]+)\]$/.exec(first.trim());
  return m === null
    ? undefined
    : { job: m[1] as string, arg: m[2] as string, rest: others.join("\n").trim() };
}

/** A cadence is a 5-field cron expression (kind `cron`) or an ISO-8601 duration (`interval`). */
export function cadenceKind(cadence: string): "cron" | "interval" {
  return /^P(?=\d|T)/.test(cadence.trim()) ? "interval" : "cron";
}

export interface ProactiveLauncherOptions<R extends LaunchRequest, Run> {
  jobs: readonly ProactiveJob[];
  /** Heartbeat runs go here (a launcher with `HEARTBEAT_TASK_BUDGET`); default: `inner`. */
  heartbeat?: Launcher<R, Run>;
  onError?: (error: unknown) => void;
}

/**
 * Runs this package's jobs for their automations, the heartbeat on its bounded launcher, and
 * passes every other run to `inner`. A job that throws fails its run (the scheduler then raises
 * its usual `task_failed` notification); a job never starts an agent turn.
 */
export function withProactiveJobs<R extends LaunchRequest, Run>(
  inner: Launcher<R, Run>,
  options: ProactiveLauncherOptions<R, Run>,
): Launcher<R, Run> {
  return {
    async launch(request) {
      // An automation made in a tainted turn never runs as an in-process job: a marker-shaped
      // prompt would otherwise hand its text to the job. It runs as the tainted task it is.
      const tainted = (request.automation.taintSources?.length ?? 0) > 0;
      const job = tainted ? undefined : options.jobs.find((j) => j.matches(request.automation));
      if (job !== undefined) {
        const result = job.run(request).catch((e: unknown): LaunchResult => {
          options.onError?.(e);
          // The summary the owner sees stays generic (the error may name a path or a key); the
          // detail rides along so the scheduler can tell a transient provider error from a bug.
          const detail = e instanceof Error ? e.message : String(e);
          return {
            status: "failed",
            summary: `${job.name} failed`,
            ...(detail === "" ? {} : { errorDetail: detail }),
            ...(e instanceof BeforeEffectError ? { noSideEffects: true } : {}),
          };
        });
        return { result };
      }
      if (request.automation.kind === "heartbeat" && options.heartbeat !== undefined) {
        return options.heartbeat.launch(request);
      }
      return inner.launch(request);
    },
    rerunOnInterrupt(automation) {
      const tainted = (automation.taintSources?.length ?? 0) > 0;
      const job = tainted ? undefined : options.jobs.find((j) => j.matches(automation));
      return job === undefined
        ? inner.rerunOnInterrupt?.(automation) === true
        : job.rerunOnInterrupt === true;
    },
    ...(inner.reattach === undefined ? {} : { reattach: (run: Run) => inner.reattach?.(run) }),
    ...(inner.cancel === undefined
      ? {}
      : { cancel: (run: Run, reason: string) => inner.cancel?.(run, reason) ?? Promise.resolve() }),
  };
}
