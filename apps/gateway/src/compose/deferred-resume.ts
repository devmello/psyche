import { type BrokerEvent, receiptGrantBinding, receiptGrantId } from "@psyche/permissions";
import type {
  ApprovalKind,
  ApprovalRequest,
  Automation,
  AutomationRun,
  Notifier,
  Receipt,
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
  /** Not reached, but the standing permission the owner gave stays: the next run does it. */
  | "not_reached_kept"
  | "expired"
  | "paused"
  | "restart"
  /** A restart cut the resume short, but the standing permission the owner gave stays. */
  | "restart_kept"
  /** The resumed action ran and failed (its receipt is not `ok`). */
  | "failed"
  /** It failed, but the standing permission the owner gave stays: the next run tries again. */
  | "failed_kept"
  /**
   * It ran (its grant let the call through) but nothing says whether it worked: no receipt
   * carries the grant's id, or the provider did not confirm.
   */
  | "unknown";

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
  /**
   * The action ran and succeeded: an `ok` receipt naming this approval, or carrying the id of
   * the standing grant it made. A use of the grant alone is not done.
   */
  done: boolean;
  /** The action ran and its receipt says it failed. */
  failed: boolean;
  /** The action ran but its receipt is `uncertain` (the provider did not confirm). */
  unknown: boolean;
  /**
   * Tasks whose call went through the grant this approval made, bound to the card's own
   * binding (another action under the same grant does not count). Only a run of this
   * automation counts: when one of those tasks finishes as its run (`#finished`), that run ends
   * the entry with its grant receipt's outcome, or unknown without one; a resume never runs it
   * again. Any other task (an attended chat through the same grant) never finishes as one.
   */
  grantTasks: Set<string>;
  /** Per task: the outcome of the receipt carrying the grant's id and the card's binding. */
  grantOutcome: Map<string, Receipt["outcome"]>;
}

interface GrantUse {
  approvalId: string;
  grantId: string;
  taskId: string;
  bindingHash: string;
}

/** A grant use or grant receipt held for a card whose entry does not exist yet. */
interface EarlyEvent {
  at: number;
  use?: GrantUse;
  receipt?: Receipt;
}

/** How long, and how many, early grant events are kept for an entry about to exist. */
const EARLY_MS = 60_000;
const EARLY_MAX = 256;

/**
 * A call went through the card's grant: kept per task, when it is the card's own action. Whose
 * run it is is checked when the task finishes (`#finished`): the scheduler records a run's
 * task only once its launch returns, after the first call may have gone through.
 */
function grantUse(entry: Entry, use: GrantUse): void {
  if (use.bindingHash === entry.approval.bindingHash) entry.grantTasks.add(use.taskId);
}

/** A receipt naming the card's grant: kept per task, read when that task finishes as a run. */
function grantReceipt(entry: Entry, r: Receipt): void {
  if (r.taskId == null || receiptGrantBinding(r) !== entry.approval.bindingHash) return;
  // A failure in the task is never hidden by another receipt.
  if (entry.grantOutcome.get(r.taskId) !== "failed") entry.grantOutcome.set(r.taskId, r.outcome);
}

/** English fallback of `notice.approvals.resumeMissed.body` (its `why`). */
const ASK_AGAIN = "If it still needs it, it will ask again.";
const MISSED_BODY: Record<MissedReason, string> = {
  not_reached: `The automation ran again but did not reach the same action, so nothing was done. ${ASK_AGAIN}`,
  expired: `The approval ran out before the automation reached the action, so nothing was done. ${ASK_AGAIN}`,
  paused: `The automation is paused or was removed, so it did not run again and nothing was done. ${ASK_AGAIN}`,
  restart: `Psyche restarted before the automation could run again, so nothing was done. ${ASK_AGAIN}`,
  not_reached_kept:
    "The automation ran again but did not reach the same action, so nothing was done. The permission you gave stays, so its next run will do this without asking. To take it back, revoke it under Standing permissions in Approvals.",
  restart_kept:
    "Psyche restarted before the automation could run again. The permission you gave stays, so its next run will do this without asking. To take it back, revoke it under Standing permissions in Approvals.",
  failed: `The automation ran the action again, but it failed. See Activity for what went wrong. ${ASK_AGAIN}`,
  failed_kept:
    "The automation ran the action again, but it failed. See Activity for what went wrong. The permission you gave stays, so its next run will try again without asking. To take it back, revoke it under Standing permissions in Approvals.",
  unknown:
    "The automation ran the action again, but Psyche can't tell whether it worked. Check Activity to see.",
};

/** A standing grant the owner gave on the card that still covers the next run. */
const KEPT_SCOPES: ReadonlySet<string> = new Set(["always", "site"]);

/**
 * The wording when that grant stays: the next run does it without asking, so never "it will
 * ask again". A task grant ends with its task and a session grant with a restart.
 */
const KEPT: Partial<Record<MissedReason, MissedReason>> = {
  not_reached: "not_reached_kept",
  restart: "restart_kept",
  failed: "failed_kept",
};

function keptGrant(a: ApprovalRequest): boolean {
  return a.scopeGranted != null && KEPT_SCOPES.has(a.scopeGranted) && a.grantId != null;
}

export class DeferredResume {
  readonly #o: DeferredResumeOptions;
  readonly #entries = new Map<string, Entry>();
  /** Grant uses and grant receipts seen before their card's entry existed (`#keepEarly`). */
  #early: EarlyEvent[] = [];
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

  /**
   * The broker's `sameAutomation`: `taskId` is a run of the automation whose run set this card
   * aside. False when either is not a run (an attended chat, a task the scheduler lost).
   */
  sameAutomation(a: ApprovalRequest, taskId: string): boolean {
    const origin = a.requestedBy.taskId;
    if (origin == null) return false;
    const card = this.#o.scheduler.runForTask(origin);
    const run = this.#o.scheduler.runForTask(taskId);
    return card !== undefined && run !== undefined && card.automationId === run.automationId;
  }

  /** The broker's `onSetAsideRevoked`: a restart ended an approval before any run used it. */
  revokedAtRestart(a: ApprovalRequest, how: { failed?: boolean; unknown?: boolean } = {}): void {
    this.#serial(async () => {
      const taskId = a.requestedBy.taskId;
      const run = taskId == null ? undefined : this.#o.scheduler.runForTask(taskId);
      this.#entries.delete(a.id);
      // An action that ran and failed before the restart says so; a kept grant's wording is
      // chosen in `#missed`.
      const why: MissedReason =
        how.failed === true ? "failed" : how.unknown === true ? "unknown" : "restart";
      await this.#missed(a, run?.automationId, why);
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
      // Synchronously: from here on a run's use of the card's grant finds its entry.
      if (e.approval.status === "approved" && e.approval.setAside === true) {
        this.#approvedNow(e.approval);
      }
    } else if (e.type === "receipt.created") {
      // Done means it succeeded: a failed or uncertain receipt is reported as not done. A call
      // its grant allowed names no approval: its receipt carries that grant's id and the call's
      // binding instead, and counts only from a run of this automation that used the grant for
      // this very action.
      const r = e.receipt;
      const own = r.approvalId == null ? undefined : this.#entries.get(r.approvalId);
      if (own !== undefined) {
        if (r.outcome === "ok") own.done = true;
        else if (r.outcome === "uncertain") own.unknown = true;
        else own.failed = true;
        return;
      }
      const grantId = receiptGrantId(r);
      if (grantId === undefined || r.taskId == null) return;
      let matched = false;
      for (const x of this.#entries.values()) {
        if (x.approval.grantId !== grantId) continue;
        matched = true;
        grantReceipt(x, r);
      }
      // Its card's entry is not there yet, but its grant was just used: keep it for the entry.
      if (!matched && this.#early.some((y) => y.use?.grantId === grantId)) {
        this.#keepEarly({ receipt: structuredClone(r) });
      }
    } else if (e.type === "grant.used") {
      // Approved with a standing scope: a call went through that grant. Not done yet: done is
      // its `ok` receipt, never the use alone (the action can still fail). Only a run of this
      // automation doing this very action counts.
      const id = e.grant.createdFromApprovalId;
      if (id == null || e.taskId === undefined) return;
      const use = {
        approvalId: id,
        grantId: e.grant.id,
        taskId: e.taskId,
        bindingHash: e.bindingHash,
      };
      const entry = this.#entries.get(id);
      if (entry !== undefined) grantUse(entry, use);
      else if (
        e.fromSetAside === true &&
        this.#o.clock.now() - Date.parse(e.grant.createdAt) < EARLY_MS
      ) {
        // The broker announces the decision right after it stores the answer, so a use comes
        // first only when the decision reaches us late (a listener before us, a test). Kept for
        // the entry, so that use is not lost and no resume does the action a second time. Only
        // grants of set-aside cards: an attended "always" grant never fills the hold.
        this.#keepEarly({ use });
      }
    }
  }

  #keepEarly(item: Omit<EarlyEvent, "at">): void {
    const now = this.#o.clock.now();
    while (this.#early.length > 0 && (this.#early[0]?.at ?? now) < now - EARLY_MS) {
      this.#early.shift();
    }
    if (this.#early.length >= EARLY_MAX) this.#early.shift();
    this.#early.push({ at: now, ...item });
  }

  /**
   * The card was approved: its entry exists from now on, with the grant uses and receipts seen
   * since its grant was stored. Starting the resume (or the notice) waits in the queue.
   */
  #approvedNow(a: ApprovalRequest): void {
    if (this.#entries.has(a.id)) return;
    const taskId = a.requestedBy.taskId;
    const run = taskId == null ? undefined : this.#o.scheduler.runForTask(taskId);
    if (run === undefined) {
      // `canResume` refused this before the broker approved it; the automation went since.
      this.#serial(() => this.#missed(a, undefined, "paused"));
      return;
    }
    const entry: Entry = {
      approval: a,
      automationId: run.automationId,
      state: "waiting",
      done: false,
      failed: false,
      unknown: false,
      grantTasks: new Set(),
      grantOutcome: new Map(),
    };
    this.#entries.set(a.id, entry);
    const rest: EarlyEvent[] = [];
    for (const y of this.#early) {
      if (y.use?.approvalId === a.id) grantUse(entry, y.use);
      else rest.push(y);
    }
    this.#early = rest.filter((y) => {
      if (y.receipt === undefined || receiptGrantId(y.receipt) !== a.grantId) return true;
      grantReceipt(entry, y.receipt);
      return false;
    });
    this.#serial(() => this.#approved(a));
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
    const entry = this.#entries.get(a.id);
    if (entry === undefined || entry.state !== "waiting") return;
    // A run in progress may still reach the call; its end starts the resume run otherwise.
    if (!this.#o.scheduler.isRunning(entry.automationId)) await this.#start(entry.automationId);
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
      // A run of this automation did the card's own action through its grant: its receipt
      // says how it went (none, or uncertain: unknown). It is over either way, never run again.
      const viaGrant = !e.done && run.taskId != null && e.grantTasks.has(run.taskId);
      if (viaGrant) {
        const outcome = e.grantOutcome.get(run.taskId as string);
        if (outcome === "ok") e.done = true;
        else if (outcome === "failed") e.failed = true;
        else if (!e.failed) e.unknown = true;
      }
      if (e.done) {
        this.#entries.delete(e.approval.id);
        this.#settle(e.approval.id);
        continue;
      }
      // Its resume run, or the run that took it, ended without the action: nothing was done.
      if (
        viaGrant ||
        e.state === "claimed" ||
        (e.state === "running" && e.resumeTaskId === run.taskId)
      ) {
        // Reached in time but the approval had run out (verifyBinding said expired), or not reached.
        const expired =
          e.approval.scopeGranted === "once" &&
          this.#o.clock.now() >= Date.parse(e.approval.expiresAt);
        await this.#end(
          e,
          e.failed ? "failed" : e.unknown ? "unknown" : expired ? "expired" : "not_reached",
        );
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
