import type { BrokerEvent } from "@psyche/permissions";
import type { ApprovalKind, ApprovalRequest, AutomationRun, Notifier } from "@psyche/protocol";

/**
 * Approve on a set-aside card (Deferred) resumes the automation, never a blind replay.
 *
 * An unattended run that reached an ask set the action aside and went on without it, so nothing
 * waits on the card. When the owner approves such a card (`setAside`), the broker records the
 * approval bound to the card's binding hash as it does for any card. This then starts a resume
 * run of the same automation, which re-plans from the start. If that run (or a run of the same
 * automation already in progress) reaches the identical call, the agent loop asks `claim` for
 * the approval and checks it with `verifyBinding`: the same kind and binding hash, once. Anything
 * else (a different file, different content, another action) asks again as usual.
 *
 * If the resume run ends without doing the action, the owner gets one notice that nothing was
 * done. If no automation can run (it was deleted), the broker refuses the approval up front
 * (`canResume`), so the app never reports an approval for something that cannot run.
 */
export const RESUME_MISSED_TITLE_KEY = "notice.approvals.resumeMissed.title";
export const RESUME_MISSED_BODY_KEY = "notice.approvals.resumeMissed.body";

export interface ResumeScheduler {
  runForTask(taskId: string): { automationId: string; runId: string } | undefined;
  isRunning(automationId: string): boolean;
  trigger(automationId: string): Promise<{ taskId: string | null }>;
  get(automationId: string): Promise<{ title: string } | undefined>;
}

export interface DeferredResumeOptions {
  scheduler: ResumeScheduler;
  notifier: Pick<Notifier, "notify">;
  /** Logged, never thrown: a failed resume becomes the "nothing was done" notice. */
  onError?: (error: unknown) => void;
}

type EntryState =
  /** Approved; waiting for the run in progress to end, or for its resume run to start. */
  | "waiting"
  /** Its resume run is going (`resumeTaskId`). */
  | "running"
  /** A run reached the identical call and took the approval. */
  | "claimed";

interface Entry {
  approval: ApprovalRequest;
  automationId: string;
  state: EntryState;
  resumeTaskId?: string;
  /** The action ran (its receipt, or a use of the grant the approval created). */
  done: boolean;
}

export class DeferredResume {
  readonly #o: DeferredResumeOptions;
  readonly #entries = new Map<string, Entry>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: DeferredResumeOptions) {
    this.#o = options;
  }

  /** The broker's `canResume`: a set-aside card of an automation that still exists. */
  canResume(a: ApprovalRequest): boolean {
    const taskId = a.requestedBy.taskId;
    if (a.setAside !== true || taskId == null) return false;
    return this.#o.scheduler.runForTask(taskId) !== undefined;
  }

  /** Approved cards that are waiting on a resume run (tests, diagnostics). */
  pending(): string[] {
    return [...this.#entries.values()].filter((e) => !e.done).map((e) => e.approval.id);
  }

  /** Feed every broker event here. */
  onBrokerEvent(e: BrokerEvent): void {
    if (e.type === "approval.decided") {
      if (e.approval.status === "approved" && e.approval.setAside === true) {
        this.#serial(() => this.#approved(e.approval));
      }
    } else if (e.type === "receipt.created") {
      const id = e.receipt.approvalId;
      const entry = id == null ? undefined : this.#entries.get(id);
      if (entry !== undefined) entry.done = true;
    } else if (e.type === "grant.used") {
      // Approved with a standing scope: the resume run's call went through that grant.
      const id = e.grant.createdFromApprovalId;
      const entry = id == null ? undefined : this.#entries.get(id);
      if (entry !== undefined) entry.done = true;
    }
  }

  /** Feed `automation.run.finished` here. */
  onRunFinished(run: AutomationRun): void {
    this.#serial(() => this.#finished(run));
  }

  /**
   * The loop's `resumeApproval`: the approval for this exact call, handed out once, to a run of
   * the automation the card came from. The loop then checks it with `verifyBinding`.
   */
  async claim(q: {
    taskId: string;
    kind: ApprovalKind;
    bindingHash: string;
    taint: boolean;
  }): Promise<string | undefined> {
    const run = this.#o.scheduler.runForTask(q.taskId);
    if (run === undefined) return undefined;
    for (const e of this.#entries.values()) {
      if (e.automationId !== run.automationId || e.state === "claimed" || e.done) continue;
      const a = e.approval;
      if (a.kind !== q.kind || a.bindingHash !== q.bindingHash) continue;
      // A tainted run never takes an approval given for an untainted card (as on re-issue).
      if (q.taint && !a.taint) continue;
      e.state = "claimed";
      return a.id;
    }
    return undefined;
  }

  #serial(fn: () => Promise<void>): void {
    const next = this.#queue.then(fn).catch((err) => this.#o.onError?.(err));
    this.#queue = next;
  }

  /** Resolves once queued work is done (tests). */
  idle(): Promise<unknown> {
    return this.#queue;
  }

  async #approved(a: ApprovalRequest): Promise<void> {
    if (this.#entries.has(a.id)) return;
    const taskId = a.requestedBy.taskId;
    const run = taskId == null ? undefined : this.#o.scheduler.runForTask(taskId);
    if (run === undefined) {
      // `canResume` refused this before the broker approved it; the automation went since.
      await this.#missed(a, undefined);
      return;
    }
    this.#entries.set(a.id, {
      approval: a,
      automationId: run.automationId,
      state: "waiting",
      done: false,
    });
    // A run in progress may still reach the call; its end starts the resume run otherwise.
    if (!this.#o.scheduler.isRunning(run.automationId)) await this.#start(run.automationId);
  }

  async #start(automationId: string): Promise<void> {
    const waiting = [...this.#entries.values()].filter(
      (e) => e.automationId === automationId && e.state === "waiting" && !e.done,
    );
    if (waiting.length === 0) return;
    let taskId: string | null;
    try {
      ({ taskId } = await this.#o.scheduler.trigger(automationId));
    } catch (err) {
      // Another run started first: its end starts this one.
      if (this.#o.scheduler.isRunning(automationId)) return;
      this.#o.onError?.(err);
      for (const e of waiting) await this.#end(e);
      return;
    }
    if (taskId === null) {
      // No agent run (a watch): nothing can reach the call.
      for (const e of waiting) await this.#end(e);
      return;
    }
    for (const e of waiting) {
      e.state = "running";
      e.resumeTaskId = taskId;
    }
  }

  async #finished(run: AutomationRun): Promise<void> {
    for (const e of [...this.#entries.values()]) {
      if (e.automationId !== run.automationId) continue;
      if (e.done) {
        this.#entries.delete(e.approval.id);
        continue;
      }
      // Its resume run, or the run that took it, ended without the action: nothing was done.
      if (e.state === "claimed" || (e.state === "running" && e.resumeTaskId === run.taskId)) {
        await this.#end(e);
      }
    }
    // Approved while that run was going and not reached by it: now start the resume run.
    await this.#start(run.automationId);
  }

  async #end(e: Entry): Promise<void> {
    this.#entries.delete(e.approval.id);
    if (!e.done) await this.#missed(e.approval, e.automationId);
  }

  async #missed(a: ApprovalRequest, automationId: string | undefined): Promise<void> {
    const automation =
      automationId === undefined ? undefined : await this.#o.scheduler.get(automationId);
    const name = (automation?.title ?? "").slice(0, 120);
    await this.#o.notifier
      .notify({
        kind: "approval",
        title:
          name === ""
            ? "An approved automation action was not done"
            : `${name}: the approved action was not done`,
        body: "The automation ran again but did not reach the same action, so nothing was done. If it still needs it, it will ask again.",
        message: {
          titleKey: RESUME_MISSED_TITLE_KEY,
          bodyKey: RESUME_MISSED_BODY_KEY,
          params: { automation: name === "" ? "none" : name },
        },
        dedupeKey: `approvals:resume-missed:${a.id}`,
        route: "/agent/approvals",
      })
      .catch((err) => this.#o.onError?.(err));
  }
}
