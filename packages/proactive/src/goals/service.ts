import {
  type Automation,
  type Clock,
  type Goal,
  type GoalLink,
  type GoalMilestone,
  type JsonObject,
  type Notifier,
  PsycheError,
  type Task,
  type TaskEngine,
  type WatchConfig,
} from "@psyche/protocol";
import { ulid } from "ulid";
import { PROACTIVITY_BUDGET } from "../budget.ts";
import {
  cadenceKind,
  jobMarker,
  type LaunchRequest,
  type LaunchResult,
  type ProactiveJob,
  parseJobMarker,
  type SchedulerLike,
} from "../jobs.ts";
import { type SqliteDatabase, toIso } from "../sqlite.ts";
import { type CheckinInput, isUntrustedEvidence, type NextStepProposer } from "./checkin.ts";
import { GoalStore } from "./store.ts";

/**
 * Goals (feature O9; architecture §4.11; UI §3.11). Stated goals are created explicitly and are
 * active at once. Inferred goals enter as `candidate` rows and become active only through
 * `decide("confirm")`: before that no automation, task, notification or link exists for them
 * (architecture §2 principle 10). Check-ins are system automations on the scheduler, recognised
 * by their prompt marker and run in-process by `checkinJob()`, which raises at most one
 * `reminder` notification per run.
 */

export const GOAL_CHECKIN_JOB = "goal-checkin";
export const GOAL_WATCH_JOB = "goal-watch";
/** Default watch interval (the scheduler backs off on failures: interval × 2^failures, ≤ 24 h). */
export const DEFAULT_WATCH_EVERY = "PT6H";

export interface GoalWatchInput {
  url: string;
  check: WatchConfig["check"];
  selector?: string;
  text?: string;
  threshold?: number;
  /** ISO-8601 duration between checks; default every 6 hours. */
  every?: string;
  title?: string;
}

export interface GoalWatchStatus {
  automationId: string;
  title: string;
  url: string | null;
  check: WatchConfig["check"] | null;
  enabled: boolean;
  lastStatus: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  /** The automation was deleted elsewhere (Upcoming); the link stays until unlinked. */
  missing: boolean;
}

export interface GoalDetail {
  goal: Goal;
  taskIds: string[];
  milestones: GoalMilestone[];
  links: GoalLink[];
}

export interface GoalProgress {
  milestones: { done: number; total: number; next: GoalMilestone | null };
  tasks: { total: number; byStatus: Record<string, number>; missing: number };
  links: { automations: number; watches: number };
  /** Linked watches with their last result (UI §3.11 "Watches"). */
  watches: GoalWatchStatus[];
}

export interface GoalCandidateInput {
  title: string;
  category: Goal["category"];
  /** Why the goal is proposed (UI "Because:"); at least one item (ADR-012: cite evidence). */
  evidence: JsonObject[];
  /** Where the candidate came from (`ideas`, `memory`, `heartbeat`), kept in `plan.source`. */
  source?: string;
  plan?: JsonObject | null;
}

export interface GoalCreateInput {
  title: string;
  category: Goal["category"];
  plan?: JsonObject | null;
  cadence?: string | null;
  timezone?: string;
  milestones?: { title: string; dueAt?: string | null }[];
}

export interface GoalPatch {
  title?: string;
  category?: Goal["category"];
  status?: "active" | "paused" | "done";
  plan?: JsonObject | null;
  cadence?: string | null;
  timezone?: string;
}

export type GoalEvent = { event: "goal.updated"; payload: { goal: Goal } };

export interface GoalsServiceOptions {
  db: SqliteDatabase;
  clock: Clock;
  scheduler: SchedulerLike;
  notifier?: Pick<Notifier, "notify">;
  /** Linked tasks' status for progress and check-ins. */
  tasks?: Pick<TaskEngine, "get">;
  newId?: () => string;
  /** Timezone for check-in schedules; default UTC. */
  timezone?: string;
  onEvent?: (event: GoalEvent) => void;
  maxOpenCandidates?: number;
  /**
   * Proposes one next step as a Home card (`createNextStepProposer`). It runs only when the owner
   * asks (`suggestNextStep`), never from a schedule: a check-in is the free reminder alone.
   */
  nextStep?: NextStepProposer;
  onError?: (error: unknown) => void;
}

/** "Check in …": the cadences the owner picks for a goal (cron, in the goal's timezone). */
export const CHECKIN_CADENCES = {
  daily: "0 9 * * *",
  weekly: "0 9 * * 1",
  monthly: "0 9 1 * *",
} as const;
export type CheckinFrequency = keyof typeof CHECKIN_CADENCES;

/** A linked task with no progress for a while (a free signal: no model call). */
export interface StalledTask {
  goal: Goal;
  task: Task;
  idleDays: number;
}

/**
 * Tasks that are not stalled: finished ones, and ones waiting on the owner (an approval, an
 * answer, a pause), where a second task would run the work twice.
 */
const NOT_STALLED: ReadonlySet<string> = new Set([
  "done",
  "failed",
  "cancelled",
  "awaiting_approval",
  "awaiting_input",
  "paused",
]);

const DAY_MS = 86_400_000;

/** At most this many evidence items are kept on a goal's plan. */
const MAX_EVIDENCE = 200;

/**
 * A plan patch replaces the plan but never drops where the goal came from: `evidence` is kept
 * (the patch may add items) and `taintedMilestones` is the union of the old and the patch's ids,
 * limited to milestones that still exist. A plan edit cannot launder taint.
 */
function mergePlan(
  old: JsonObject | null,
  patch: JsonObject | null,
  milestoneIds: ReadonlySet<string>,
): JsonObject | null {
  const next: JsonObject = { ...(patch ?? {}) };
  let evidence: unknown[] = [];
  const seen = new Set<string>();
  for (const item of [
    ...(Array.isArray(old?.evidence) ? old.evidence : []),
    ...(Array.isArray(patch?.evidence) ? patch.evidence : []),
  ]) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push(item);
  }
  if (evidence.length > MAX_EVIDENCE) {
    // Over the cap: drop the oldest owner-trusted items first. Untrusted items are what marks the
    // goal tainted, so they go last (and the newest of them always stay).
    const isOutside = (e: unknown) =>
      typeof e !== "object" ||
      e === null ||
      Array.isArray(e) ||
      isUntrustedEvidence(e as JsonObject);
    let excess = evidence.length - MAX_EVIDENCE;
    const drop = new Set<number>();
    for (const outside of [false, true]) {
      for (let i = 0; i < evidence.length && excess > 0; i++) {
        if (isOutside(evidence[i]) === outside && !drop.has(i)) {
          drop.add(i);
          excess--;
        }
      }
    }
    evidence = evidence.filter((_, i) => !drop.has(i));
  }
  if (evidence.length > 0) next.evidence = evidence as never;
  const tainted = new Set<string>(
    [
      ...(Array.isArray(old?.taintedMilestones) ? old.taintedMilestones : []),
      ...(Array.isArray(patch?.taintedMilestones) ? patch.taintedMilestones : []),
    ].filter((id): id is string => typeof id === "string" && milestoneIds.has(id)),
  );
  if (tainted.size > 0) next.taintedMilestones = [...tainted];
  else delete next.taintedMilestones;
  return Object.keys(next).length === 0 && patch === null ? null : next;
}

/** At most once a day: a daily time of day in cron, or a duration of 24 hours or more. */
function assertCheckinCadence(cadence: string): void {
  const value = cadence.trim();
  if ((Object.values(CHECKIN_CADENCES) as string[]).includes(value)) return;
  if (cadenceKind(value) === "interval") {
    const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
    const ms =
      m === null
        ? 0
        : (Number(m[1] ?? 0) * 7 + Number(m[2] ?? 0)) * DAY_MS +
          Number(m[3] ?? 0) * 3_600_000 +
          Number(m[4] ?? 0) * 60_000 +
          Number(m[5] ?? 0) * 1000;
    if (ms >= DAY_MS) return;
  } else {
    const f = value.split(/\s+/);
    if (f.length === 5 && /^\d+$/.test(f[0] ?? "") && /^\d+$/.test(f[1] ?? "")) return;
  }
  bad("check-ins run at most once a day: use a daily time (like 0 9 * * 1) or P1D or longer");
}

const DEFER_DAYS = 7;

function bad(message: string): never {
  throw new PsycheError("invalid_params", message);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

export class GoalsService {
  readonly store: GoalStore;
  readonly #o: GoalsServiceOptions;

  constructor(options: GoalsServiceOptions) {
    this.#o = options;
    this.store = new GoalStore(options.db);
  }

  #now(): string {
    return toIso(this.#o.clock.now());
  }

  #id(): string {
    return this.#o.newId?.() ?? ulid(this.#o.clock.now());
  }

  #emit(goal: Goal): void {
    this.#o.onEvent?.({ event: "goal.updated", payload: { goal: cloneJson(goal) } });
  }

  #goal(id: string): Goal {
    const g = this.store.get(id);
    if (g === undefined) throw new PsycheError("not_found", `goal ${id} not found`);
    return g;
  }

  /** A candidate has no milestones, links or check-ins until it is confirmed. */
  #confirmed(goal: Goal): Goal {
    if (goal.status === "candidate") {
      throw new PsycheError("conflict", "confirm the goal first; candidates cannot be changed");
    }
    if (goal.status === "archived") {
      throw new PsycheError("conflict", "the goal is archived");
    }
    return goal;
  }

  // --- stated goals ----------------------------------------------------------------------------

  /** A stated goal (chat, Goals screen): active at once; a cadence schedules check-ins. */
  async create(input: GoalCreateInput): Promise<GoalDetail> {
    if (input.title.trim() === "") bad("title is required");
    if (input.cadence != null) assertCheckinCadence(input.cadence);
    const now = this.#now();
    const goal: Goal = {
      id: this.#id(),
      title: input.title.trim(),
      category: input.category,
      status: "active",
      inferred: false,
      confirmedAt: now,
      plan: input.plan ?? null,
      cadence: input.cadence ?? null,
      nextCheckinAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.transaction(() => {
      this.store.insert(goal);
      for (const m of input.milestones ?? []) {
        if (m.title.trim() === "") bad("milestone title is required");
        this.store.insertMilestone({
          id: this.#id(),
          goalId: goal.id,
          title: m.title.trim(),
          dueAt: m.dueAt ?? null,
          doneAt: null,
        });
      }
    });
    try {
      await this.#syncCheckin(goal, input.timezone);
    } catch (e) {
      this.store.delete(goal.id);
      throw e;
    }
    this.#emit(goal);
    return this.get(goal.id);
  }

  // --- inferred candidates ---------------------------------------------------------------------

  /**
   * Proposes an inferred goal as a candidate (never active). Returns `undefined` when the
   * proposal is suppressed: the same goal was rejected before, or the budget of open candidates
   * is used up. An open goal with the same title is returned instead of a duplicate.
   */
  async propose(input: GoalCandidateInput): Promise<Goal | undefined> {
    if (input.title.trim() === "") bad("title is required");
    if (input.evidence.length === 0) bad("a candidate needs evidence");
    const same = this.store.findByTitle(input.title);
    const rejected = same.find(
      (g) => g.inferred && g.status === "archived" && g.confirmedAt == null,
    );
    if (rejected !== undefined) return undefined;
    const open = same.find((g) => g.status !== "archived");
    if (open !== undefined) return open;
    const max = this.#o.maxOpenCandidates ?? PROACTIVITY_BUDGET.goals.maxOpenCandidates;
    if (this.store.list({ status: ["candidate"] }).length >= max) return undefined;
    const now = this.#now();
    const goal: Goal = {
      id: this.#id(),
      title: input.title.trim(),
      category: input.category,
      status: "candidate",
      inferred: true,
      confirmedAt: null,
      plan: {
        ...(input.plan ?? {}),
        evidence: cloneJson(input.evidence),
        ...(input.source === undefined ? {} : { source: input.source }),
      },
      cadence: null,
      nextCheckinAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insert(goal);
    this.#emit(goal);
    return goal;
  }

  /** `confirm` activates; `reject` archives (and suppresses re-proposal); `later` defers. */
  async decide(goalId: string, decision: "confirm" | "reject" | "later"): Promise<Goal> {
    const goal = this.#goal(goalId);
    if (goal.status !== "candidate") {
      throw new PsycheError("conflict", `goal ${goalId} is not a candidate`);
    }
    const now = this.#now();
    const nowMs = this.#o.clock.now();
    const plan = { ...(goal.plan ?? {}) };
    let next: Goal;
    if (decision === "confirm") {
      next = { ...goal, status: "active", confirmedAt: now, plan, updatedAt: now };
    } else if (decision === "reject") {
      next = { ...goal, status: "archived", archivedAt: now, plan, updatedAt: now };
    } else {
      const deferrals = typeof plan.deferrals === "number" ? plan.deferrals + 1 : 1;
      next = {
        ...goal,
        plan: { ...plan, deferrals, deferredUntil: toIso(nowMs + DEFER_DAYS * 86_400_000) },
        updatedAt: now,
      };
    }
    this.store.update(next);
    if (decision === "confirm") await this.#syncCheckin(next);
    this.#emit(next);
    return this.#goal(goalId);
  }

  // --- read ------------------------------------------------------------------------------------

  async list(filter: {
    status?: readonly Goal["status"][];
    category?: Goal["category"];
  }): Promise<Goal[]> {
    return this.store.list({
      status: filter.status ?? ["active", "candidate"],
      ...(filter.category === undefined ? {} : { category: filter.category }),
    });
  }

  async get(goalId: string): Promise<GoalDetail> {
    const goal = this.#goal(goalId);
    const links = this.store.links(goalId);
    return {
      goal,
      taskIds: links.flatMap((l) => (l.taskId == null ? [] : [l.taskId])),
      milestones: this.store.milestones(goalId),
      links,
    };
  }

  /** Progress for the goal page and the check-in message. */
  async progress(goalId: string): Promise<GoalProgress> {
    const detail = await this.get(goalId);
    const done = detail.milestones.filter((m) => m.doneAt != null).length;
    const next = detail.milestones.find((m) => m.doneAt == null) ?? null;
    const byStatus: Record<string, number> = {};
    let missing = 0;
    for (const id of detail.taskIds) {
      const task: Task | undefined = await this.#o.tasks?.get(id);
      if (task === undefined) {
        missing += 1;
        continue;
      }
      byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    }
    const watches: GoalWatchStatus[] = [];
    for (const l of detail.links) {
      if (l.watchId == null) continue;
      const a = await this.#o.scheduler.get(l.watchId);
      watches.push({
        automationId: l.watchId,
        title: a?.title ?? "(deleted watch)",
        url: a?.watch?.url ?? null,
        check: a?.watch?.check ?? null,
        enabled: a?.enabled ?? false,
        lastStatus: a?.lastStatus ?? null,
        lastRunAt: a?.lastRunAt ?? null,
        nextRunAt: a?.nextRunAt ?? null,
        missing: a === undefined,
      });
    }
    return {
      milestones: { done, total: detail.milestones.length, next },
      tasks: { total: detail.taskIds.length, byStatus, missing },
      links: {
        automations: detail.links.filter((l) => l.automationId != null).length,
        watches: watches.length,
      },
      watches,
    };
  }

  /**
   * The owner's "Check in weekly" switch: `null` turns check-ins off (the default). A check-in
   * is the free progress reminder; it never calls a model (`suggestNextStep` does, on request).
   */
  async setCheckin(
    goalId: string,
    frequency: CheckinFrequency | null,
    timezone?: string,
  ): Promise<GoalDetail> {
    return this.update(goalId, {
      cadence: frequency === null ? null : CHECKIN_CADENCES[frequency],
      ...(timezone === undefined ? {} : { timezone }),
    });
  }

  /**
   * Linked tasks of active goals that have made no progress for `days` (a free signal: reads
   * state only, never a model). Finished tasks and tasks waiting on the owner are not stalled.
   */
  async stalledTasks(days = PROACTIVITY_BUDGET.goals.stalledAfterDays): Promise<StalledTask[]> {
    const cutoff = this.#o.clock.now() - days * DAY_MS;
    const out: StalledTask[] = [];
    for (const goal of this.store.list({ status: ["active"] })) {
      for (const link of this.store.links(goal.id)) {
        if (link.taskId == null) continue;
        const task = await this.#o.tasks?.get(link.taskId);
        if (task === undefined || NOT_STALLED.has(task.status)) continue;
        const idle = this.#o.clock.now() - Date.parse(task.updatedAt);
        if (Date.parse(task.updatedAt) > cutoff) continue;
        out.push({ goal, task, idleDays: Math.floor(idle / DAY_MS) });
      }
    }
    return out;
  }

  /**
   * "Suggest next step" (the owner's tap): one model call, one Home card. Everything the owner
   * did not write (outside evidence, tainted tasks and milestones, an inferred title) goes to the
   * model fenced, and taints the card and the task it starts. Nothing starts here.
   */
  async suggestNextStep(goalId: string): Promise<{ ideaId: string | null }> {
    const goal = this.#confirmed(this.#goal(goalId));
    if (goal.status !== "active") throw new PsycheError("conflict", "the goal is not active");
    const propose = this.#o.nextStep;
    if (propose === undefined) throw new PsycheError("unavailable", "no model is configured");
    const detail = await this.get(goalId);
    const taintedMilestones = new Set(
      Array.isArray(goal.plan?.taintedMilestones) ? goal.plan.taintedMilestones : [],
    );
    const tasks: CheckinInput["tasks"] = [];
    for (const id of detail.taskIds) {
      const t = await this.#o.tasks?.get(id);
      if (t === undefined) continue;
      tasks.push({
        title: t.title,
        status: t.status,
        idleDays: Math.max(0, Math.floor((this.#o.clock.now() - Date.parse(t.updatedAt)) / DAY_MS)),
        tainted: t.taint === true || (t.taintSources?.length ?? 0) > 0,
      });
    }
    const evidence = Array.isArray(goal.plan?.evidence)
      ? (goal.plan.evidence as unknown[]).filter(
          (e): e is JsonObject => typeof e === "object" && e !== null && !Array.isArray(e),
        )
      : [];
    const ideaId = await propose({
      goal,
      milestones: detail.milestones.map((m) => ({
        title: m.title,
        done: m.doneAt != null,
        tainted: taintedMilestones.has(m.id),
      })),
      tasks,
      evidence,
    });
    return { ideaId: ideaId ?? null };
  }

  // --- watches (O3) ----------------------------------------------------------------------------

  /**
   * A watch for a goal ("registration page - price", UI §3.11): a scheduler `watch` automation
   * linked through `goal_links.watch_id` (the automation's id). The scheduler checks the page
   * through its injected fetch, alerts once per transition (a price drop produces one alert),
   * backs off on failures and never starts the agent. It runs only while the goal is active.
   */
  async addWatch(
    goalId: string,
    input: GoalWatchInput,
  ): Promise<{ automation: Automation; detail: GoalDetail }> {
    const goal = this.#confirmed(this.#goal(goalId));
    const automation = await this.#o.scheduler.create({
      kind: "watch",
      title: input.title?.trim() || `Watch for "${goal.title}"`,
      schedule: input.every ?? DEFAULT_WATCH_EVERY,
      timezone: this.#o.timezone ?? "UTC",
      sessionTarget: "isolated",
      delivery: {},
      prompt: jobMarker(GOAL_WATCH_JOB, goal.id),
      enabled: goal.status === "active",
      scratch: null,
      watch: {
        url: input.url,
        check: input.check,
        ...(input.selector === undefined ? {} : { selector: input.selector }),
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
      },
    });
    try {
      await this.link({ goalId, watchId: automation.id });
    } catch (e) {
      await this.#o.scheduler.remove(automation.id);
      throw e;
    }
    return { automation, detail: await this.get(goalId) };
  }

  /** Unlinks a watch and deletes its automation. */
  async removeWatch(goalId: string, automationId: string): Promise<GoalDetail> {
    const goal = this.#goal(goalId);
    if (!this.store.links(goalId).some((l) => l.watchId === automationId)) {
      throw new PsycheError("not_found", "watch not linked to this goal");
    }
    this.store.unlink({ goalId, taskId: null, automationId: null, watchId: automationId });
    if ((await this.#o.scheduler.get(automationId)) !== undefined) {
      await this.#o.scheduler.remove(automationId);
    }
    // Patch onto the current row: a milestone written during the awaits above keeps its taint.
    const current = this.store.get(goalId);
    if (current !== undefined) {
      const touched: Goal = { ...current, updatedAt: this.#now() };
      this.store.update(touched);
      this.#emit(touched);
    }
    return this.get(goalId);
  }

  /** Linked watches run only while the goal is active (pause, done and archive stop them). */
  async #syncWatches(goal: Goal): Promise<void> {
    const enabled = goal.status === "active";
    for (const l of this.store.links(goal.id)) {
      if (l.watchId == null) continue;
      const a = await this.#o.scheduler.get(l.watchId);
      if (a !== undefined && a.enabled !== enabled) {
        await this.#o.scheduler.update(a.id, { enabled });
      }
    }
  }

  // --- change ----------------------------------------------------------------------------------

  async update(goalId: string, patch: GoalPatch): Promise<GoalDetail> {
    const goal = this.#confirmed(this.#goal(goalId));
    if (patch.title !== undefined && patch.title.trim() === "") bad("title is required");
    if (patch.cadence != null) assertCheckinCadence(patch.cadence);
    const next: Goal = {
      ...goal,
      ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
      ...(patch.category === undefined ? {} : { category: patch.category }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.plan === undefined
        ? {}
        : {
            plan: mergePlan(
              goal.plan ?? null,
              patch.plan,
              new Set(this.store.milestones(goalId).map((m) => m.id)),
            ),
          }),
      ...(patch.cadence === undefined ? {} : { cadence: patch.cadence }),
      updatedAt: this.#now(),
    };
    this.store.update(next);
    try {
      await this.#syncCheckin(next, patch.timezone);
    } catch (e) {
      // Revert only the fields this call patched, and only where nobody has changed them since.
      const current = this.store.get(goalId);
      if (current !== undefined) {
        const back: Goal = { ...current, updatedAt: goal.updatedAt };
        for (const key of ["title", "category", "status", "plan", "cadence"] as const) {
          if (JSON.stringify(current[key]) === JSON.stringify(next[key])) {
            (back as unknown as Record<string, unknown>)[key] = goal[key];
          }
        }
        this.store.update(back);
      }
      throw e;
    }
    if (patch.status !== undefined && patch.status !== goal.status) await this.#syncWatches(next);
    this.#emit(this.#goal(goalId));
    return this.get(goalId);
  }

  async archive(goalId: string): Promise<Goal> {
    const goal = this.#goal(goalId);
    if (goal.status === "archived") return goal;
    const now = this.#now();
    const next: Goal = { ...goal, status: "archived", archivedAt: now, updatedAt: now };
    this.store.update(next);
    await this.#syncCheckin(next);
    await this.#syncWatches(next);
    const stored = this.#goal(goalId);
    this.#emit(stored);
    return stored;
  }

  async milestone(params: {
    goalId: string;
    milestoneId?: string;
    title?: string;
    dueAt?: string | null;
    done?: boolean;
    remove?: boolean;
    /** The writing turn's taint sources: a tainted title is fenced and taints what it feeds. */
    taintSources?: unknown[];
  }): Promise<GoalDetail> {
    const goal = this.#confirmed(this.#goal(params.goalId));
    const tainted = (params.taintSources?.length ?? 0) > 0;
    const taintedIds = new Set<string>(
      Array.isArray(goal.plan?.taintedMilestones) ? (goal.plan.taintedMilestones as string[]) : [],
    );
    if (params.milestoneId === undefined) {
      if (params.remove === true) bad("milestoneId is required to remove a milestone");
      if (params.title === undefined || params.title.trim() === "") {
        bad("a new milestone needs a title");
      }
      const id = this.#id();
      this.store.insertMilestone({
        id,
        goalId: goal.id,
        title: params.title.trim(),
        dueAt: params.dueAt ?? null,
        doneAt: params.done === true ? this.#now() : null,
      });
      if (tainted) taintedIds.add(id);
    } else {
      const m = this.store.milestone(goal.id, params.milestoneId);
      if (m === undefined) throw new PsycheError("not_found", "milestone not found");
      if (params.remove === true) {
        this.store.removeMilestone(goal.id, m.id);
        taintedIds.delete(m.id);
      } else {
        if (params.title !== undefined) {
          if (tainted) taintedIds.add(m.id);
          else taintedIds.delete(m.id);
        }
        if (params.title !== undefined && params.title.trim() === "") bad("title is required");
        this.store.updateMilestone({
          ...m,
          ...(params.title === undefined ? {} : { title: params.title.trim() }),
          ...(params.dueAt === undefined ? {} : { dueAt: params.dueAt }),
          ...(params.done === undefined
            ? {}
            : { doneAt: params.done ? (m.doneAt ?? this.#now()) : null }),
        });
      }
    }
    const plan: JsonObject = { ...(goal.plan ?? {}) };
    if (taintedIds.size > 0) plan.taintedMilestones = [...taintedIds];
    else delete plan.taintedMilestones;
    const touched: Goal = {
      ...goal,
      plan: Object.keys(plan).length === 0 && goal.plan == null ? null : plan,
      updatedAt: this.#now(),
    };
    this.store.update(touched);
    this.#emit(touched);
    return this.get(goal.id);
  }

  async link(params: {
    goalId: string;
    taskId?: string;
    automationId?: string;
    watchId?: string;
    unlink?: boolean;
  }): Promise<void> {
    const goal = this.#confirmed(this.#goal(params.goalId));
    const set = [params.taskId, params.automationId, params.watchId].filter((v) => v !== undefined);
    if (set.length !== 1) bad("link exactly one of taskId, automationId, watchId");
    const link: GoalLink = {
      goalId: goal.id,
      taskId: params.taskId ?? null,
      automationId: params.automationId ?? null,
      watchId: params.watchId ?? null,
    };
    if (params.unlink === true) this.store.unlink(link);
    else this.store.link(link, this.#now());
    const touched: Goal = { ...goal, updatedAt: this.#now() };
    this.store.update(touched);
    this.#emit(touched);
  }

  // --- check-ins through the scheduler ---------------------------------------------------------

  async #checkinAutomation(goalId: string): Promise<Automation | undefined> {
    const marker = jobMarker(GOAL_CHECKIN_JOB, goalId);
    return (await this.#o.scheduler.list()).find((a) => a.prompt.trim() === marker);
  }

  /** Makes the scheduler match the goal: one enabled check-in for an active goal with a cadence. */
  async #syncCheckin(goal: Goal, timezone?: string): Promise<void> {
    const existing = await this.#checkinAutomation(goal.id);
    const wants = goal.cadence != null && goal.status !== "archived";
    if (!wants) {
      if (existing !== undefined) await this.#o.scheduler.remove(existing.id);
      if (this.store.get(goal.id)?.nextCheckinAt != null) this.#patchNextCheckin(goal.id, null);
      return;
    }
    const cadence = (goal.cadence ?? "").trim();
    const kind = cadenceKind(cadence);
    const fields = {
      title: `Check-in: ${goal.title}`,
      schedule: cadence,
      timezone: timezone ?? existing?.timezone ?? this.#o.timezone ?? "UTC",
      sessionTarget: "main",
      delivery: {},
      prompt: jobMarker(GOAL_CHECKIN_JOB, goal.id),
      enabled: goal.status === "active",
      scratch: null,
    };
    let automation: Automation;
    if (existing === undefined) {
      automation = await this.#o.scheduler.create({ kind, system: true, ...fields });
    } else if (existing.kind !== kind) {
      await this.#o.scheduler.remove(existing.id);
      automation = await this.#o.scheduler.create({ kind, system: true, ...fields });
    } else {
      automation = await this.#o.scheduler.update(existing.id, fields);
    }
    this.#patchNextCheckin(goal.id, automation.nextRunAt ?? null);
  }

  /** Writes only `nextCheckinAt` onto the current row: a write that landed meanwhile survives. */
  #patchNextCheckin(goalId: string, nextCheckinAt: string | null): void {
    const current = this.store.get(goalId);
    if (current !== undefined) this.store.update({ ...current, nextCheckinAt });
  }

  /**
   * After a restart: re-create check-ins the scheduler lost, refresh `nextCheckinAt`, and drop
   * check-ins whose goal is gone.
   */
  async start(): Promise<void> {
    const automations = await this.#o.scheduler.list();
    for (const a of automations) {
      const marker = parseJobMarker(a.prompt);
      if (marker?.job !== GOAL_CHECKIN_JOB) continue;
      if (this.store.get(marker.arg) === undefined) await this.#o.scheduler.remove(a.id);
    }
    for (const goal of this.store.list({ status: ["active", "paused", "done"] })) {
      if (goal.cadence != null) await this.#syncCheckin(goal);
    }
  }

  /** The in-process job behind check-in automations (`withProactiveJobs`). */
  checkinJob(): ProactiveJob {
    return {
      name: "goal check-in",
      // Reads and proposes only: safe to run again after a restart cut it off.
      rerunOnInterrupt: true,
      matches: (a) => parseJobMarker(a.prompt)?.job === GOAL_CHECKIN_JOB,
      run: (request) => this.#runCheckin(request),
    };
  }

  async #runCheckin(request: LaunchRequest): Promise<LaunchResult> {
    const goalId = parseJobMarker(request.automation.prompt)?.arg ?? "";
    const goal = this.store.get(goalId);
    if (goal === undefined || goal.status !== "active") {
      return { status: "no_reply", summary: "The goal is not active; no check-in" };
    }
    const progress = await this.progress(goalId);
    const parts = [
      `${progress.milestones.done}/${progress.milestones.total} milestones done`,
      progress.milestones.next === null
        ? null
        : `next: ${progress.milestones.next.title}${progress.milestones.next.dueAt == null ? "" : ` (due ${progress.milestones.next.dueAt.slice(0, 10)})`}`,
      progress.tasks.total === 0
        ? null
        : `tasks: ${Object.entries(progress.tasks.byStatus)
            .map(([s, n]) => `${n} ${s}`)
            .join(", ")}`,
    ].filter((p): p is string => p !== null);
    if (request.run.coalesced > 1) {
      parts.push(`covers ${request.run.coalesced} missed check-ins`);
    }
    const body = parts.join(" · ");
    // One `reminder` per check-in (PROACTIVITY_BUDGET.goals.notificationsPerCheckin); the row is
    // dismissible through `notifications.resolve` and attributable through its route.
    await this.#o.notifier?.notify({
      kind: "reminder",
      title: `Check-in: ${goal.title}`,
      body,
      route: `/goals/${goal.id}`,
      dedupeKey: `goal:${goal.id}:checkin`,
    });
    const automation = await this.#o.scheduler.get(request.automation.id);
    // Patch onto the current row: a milestone written during the awaits above keeps its taint.
    const current = this.store.get(goal.id) ?? goal;
    const next: Goal = {
      ...current,
      nextCheckinAt: automation?.nextRunAt ?? current.nextCheckinAt,
      updatedAt: this.#now(),
    };
    this.store.update(next);
    this.#emit(next);
    return { status: "no_reply", summary: body };
  }
}
