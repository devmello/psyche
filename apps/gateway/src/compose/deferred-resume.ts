import type { BrokerEvent } from "@psyche/permissions";
import type {
  ApprovalKind,
  ApprovalRequest,
  Automation,
  AutomationRun,
  Notifier,
} from "@psyche/protocol";

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
 * done, and so on every other way it can't happen: the approval ran out first, the automation was
 * paused or removed in the meantime, or a restart revoked the approval (`revokedAtRestart`). If
 * the automation is paused or gone when the owner taps Approve, the broker refuses the approval
 * up front (`canResume`): approving never restarts an automation the owner turned off.
 */
export const RESUME_MISSED_TITLE_KEY = "notice.approvals.resumeMissed.title";
export const RESUME_MISSED_BODY_KEY = "notice.approvals.resumeMissed.body";

export interface ResumeScheduler {
  runForTask(taskId: string): { automationId: string; runId: string } | undefined;
  isRunning(automationId: string): boolean;
  trigger(automationId: string): Promise<{ taskId: string | null }>;
  get(automationId: string): Promise<Automation | undefined>;
}

/** Why a promised resume did not do the action (the notice's `why`). */
export type MissedReason =
  | "not_reached"
  | "expired"
  | "paused"
  | "restart"
  /** A restart cut the resume short, but the standing permission the owner gave stays. */
  | "restart_kept"
  /** The resumed action ran and failed (its receipt is not `ok`). */
  | "failed"
  /** It failed, but the standing permission the owner gave stays: the next run tries again. */
  | "failed_kept";

export interface DeferredResumeOptions {
  scheduler: ResumeScheduler;
  notifier: Pick<Notifier, "notify">;
  clock: { now(): number };
  /** A built-in routine the owner paused in Scheduled (its `enabled` stays on). */
  isPaused?: (automation: Automation) => boolean;
  /**
   * The broker's `settleSetAside`: this card's resume is over (done, or the owner was told), so a
   * restart has nothing more to say about it.
   */
  settle?: (approvalId: string) => void;
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
  /** The action ran and succeeded (an `ok` receipt, or a use of the grant the approval made). */
  done: boolean;
  /** The action ran but its receipt is not `ok`: it failed, or its outcome is unknown. */
  failed: boolean;
  /**
   * Tasks whose call went through the standing grant this approval made, waiting for that
   * call's receipt (it names no approval): only an `ok` one makes it done.
   */
  grantTasks: Set<string>;
}

/** English fallback of `notice.approvals.resumeMissed.body` (its `why`). */
const ASK_AGAIN = "If it still needs it, it will ask again.";
const MISSED_BODY: Record<MissedReason, string> = {
  not_reached: `The automation ran again but did not reach the same action, so nothing was done. ${ASK_AGAIN}`,
  expired: `The approval ran out before the automation reached the action, so nothing was done. ${ASK_AGAIN}`,
  paused: `The automation is paused or was removed, so it did not run again and nothing was done. ${ASK_AGAIN}`,
  restart: `Psyche restarted before the automation could run again, so nothing was done. ${ASK_AGAIN}`,
  restart_kept:
    "Psyche restarted before the automation could run again. The permission you gave stays, so its next run will do this without asking. To take it back, revoke it under Standing permissions in Approvals.",
  failed: `The automation ran the action again, but it failed. See Activity for what went wrong. ${ASK_AGAIN}`,
  failed_kept:
    "The automation ran the action again, but it failed. See Activity for what went wrong. The permission you gave stays, so its next run will try again without asking. To take it back, revoke it under Standing permissions in Approvals.",
};

/** A standing grant the owner gave on the card that still covers the next run. */
const KEPT_SCOPES: ReadonlySet<string> = new Set(["always", "site"]);

/**
 * The wording when that grant stays: the next run does it without asking, so never "it will
 * ask again". A task grant ends with its task and a session grant with a restart.
 */
const KEPT: Partial<Record<MissedReason, MissedReason>> = {
  restart: "restart_kept",
  failed: "failed_kept",
};

function keptGrant(a: ApprovalRequest): boolean {
  return a.scopeGranted != null && KEPT_SCOPES.has(a.scopeGranted) && a.grantId != null;
}

export class DeferredResume {
  readonly #o: DeferredResumeOptions;
  readonly #entries = new Map<string, Entry>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: DeferredResumeOptions) {
    this.#o = options;
  }

  /**
   * The broker's `canResume`: a set-aside card of an automation that exists, is switched on and
   * is not paused. Approving never restarts an automation the owner turned off.
   */
  async canResume(a: ApprovalRequest): Promise<boolean> {
    const taskId = a.requestedBy.taskId;
    if (a.setAside !== true || taskId == null) return false;
    const run = this.#o.scheduler.runForTask(taskId);
    return run !== undefined && (await this.#runnable(run.automationId));
  }

  /** The broker's `onSetAsideRevoked`: a restart ended an approval before any run used it. */
  revokedAtRestart(a: ApprovalRequest, how: { failed?: boolean } = {}): void {
    this.#serial(async () => {
      const taskId = a.requestedBy.taskId;
      const run = taskId == null ? undefined : this.#o.scheduler.runForTask(taskId);
      this.#entries.delete(a.id);
      // An action that ran and failed before the restart says so; a kept grant's wording is
      // chosen in `#missed`.
      await this.#missed(a, run?.automationId, how.failed === true ? "failed" : "restart");
    });
  }

  async #runnable(automationId: string): Promise<boolean> {
    const automation = await this.#o.scheduler.get(automationId);
    if (automation === undefined || automation.enabled !== true) return false;
    try {
      return this.#o.isPaused?.(automation) !== true;
    } catch {
      return false;
    }
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
      // Done means it succeeded: a failed or uncertain receipt is reported as not done.
      const r = e.receipt;
      const entry =
        r.approvalId != null
          ? this.#entries.get(r.approvalId)
          : r.taskId == null
            ? undefined
            : // A call its grant allowed: the receipt of that kind, in the task that used it.
              [...this.#entries.values()].find(
                (x) => x.grantTasks.has(r.taskId as string) && x.approval.kind === r.kind,
              );
      if (entry !== undefined) {
        if (r.taskId != null) entry.grantTasks.delete(r.taskId);
        if (r.outcome === "ok") entry.done = true;
        else entry.failed = true;
      }
    } else if (e.type === "grant.used") {
      // Approved with a standing scope: a call went through that grant. Not done yet: done is
      // its `ok` receipt, never the use alone (the action can still fail).
      const id = e.grant.createdFromApprovalId;
      const entry = id == null ? undefined : this.#entries.get(id);
      if (entry !== undefined && e.taskId !== undefined) entry.grantTasks.add(e.taskId);
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
      await this.#missed(a, undefined, "paused");
      return;
    }
    this.#entries.set(a.id, {
      approval: a,
      automationId: run.automationId,
      state: "waiting",
      done: false,
      failed: false,
      grantTasks: new Set(),
    });
    // A run in progress may still reach the call; its end starts the resume run otherwise.
    if (!this.#o.scheduler.isRunning(run.automationId)) await this.#start(run.automationId);
  }

  async #start(automationId: string): Promise<void> {
    const waiting = [...this.#entries.values()].filter(
      (e) => e.automationId === automationId && e.state === "waiting" && !e.done,
    );
    if (waiting.length === 0) return;
    // Checked again right before the run: paused or removed since the tap means no run.
    if (!(await this.#runnable(automationId))) {
      for (const e of waiting) await this.#end(e, "paused");
      return;
    }
    // An approval that has run out can no longer be used: say so instead of running for nothing.
    const now = this.#o.clock.now();
    const live: Entry[] = [];
    for (const e of waiting) {
      if (e.approval.scopeGranted === "once" && now >= Date.parse(e.approval.expiresAt))
        await this.#end(e, "expired");
      else live.push(e);
    }
    if (live.length === 0) return;
    let taskId: string | null;
    try {
      ({ taskId } = await this.#o.scheduler.trigger(automationId));
    } catch (err) {
      // Another run started first: its end starts this one.
      if (this.#o.scheduler.isRunning(automationId)) return;
      this.#o.onError?.(err);
      for (const e of live) await this.#end(e);
      return;
    }
    if (taskId === null) {
      // No agent run (a watch): nothing can reach the call.
      for (const e of live) await this.#end(e);
      return;
    }
    for (const e of live) {
      e.state = "running";
      e.resumeTaskId = taskId;
    }
  }

  async #finished(run: AutomationRun): Promise<void> {
    for (const e of [...this.#entries.values()]) {
      if (e.automationId !== run.automationId) continue;
      // Its grant let this run's call through and no receipt came: it ran, outcome unknown.
      if (!e.done && run.taskId != null && e.grantTasks.delete(run.taskId)) e.failed = true;
      if (e.done) {
        this.#entries.delete(e.approval.id);
        this.#settle(e.approval.id);
        continue;
      }
      // Its resume run, or the run that took it, ended without the action: nothing was done.
      if (e.state === "claimed" || (e.state === "running" && e.resumeTaskId === run.taskId)) {
        // Reached in time but the approval had run out (verifyBinding said expired), or not reached.
        const expired =
          e.approval.scopeGranted === "once" &&
          this.#o.clock.now() >= Date.parse(e.approval.expiresAt);
        await this.#end(e, e.failed ? "failed" : expired ? "expired" : "not_reached");
      }
    }
    // Approved while that run was going and not reached by it: now start the resume run.
    await this.#start(run.automationId);
  }

  async #end(e: Entry, why: MissedReason = "not_reached"): Promise<void> {
    this.#entries.delete(e.approval.id);
    if (!e.done) await this.#missed(e.approval, e.automationId, why);
    else this.#settle(e.approval.id);
  }

  #settle(approvalId: string): void {
    try {
      this.#o.settle?.(approvalId);
    } catch (err) {
      this.#o.onError?.(err);
    }
  }

  async #missed(
    a: ApprovalRequest,
    automationId: string | undefined,
    why: MissedReason,
  ): Promise<void> {
    // Told once: a restart does not report it again.
    this.#settle(a.id);
    const shown = keptGrant(a) ? (KEPT[why] ?? why) : why;
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
        body: MISSED_BODY[shown],
        message: {
          titleKey: RESUME_MISSED_TITLE_KEY,
          bodyKey: RESUME_MISSED_BODY_KEY,
          params: { automation: name === "" ? "none" : name, why: shown },
        },
        dedupeKey: `approvals:resume-missed:${a.id}`,
        route: "/agent/approvals",
      })
      .catch((err) => this.#o.onError?.(err));
  }
}
