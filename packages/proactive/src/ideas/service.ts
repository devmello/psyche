import {
  type Clock,
  type Idea,
  type MemoryStore,
  type Notifier,
  PsycheError,
  type TaskEngine,
} from "@psyche/protocol";
import { ulid } from "ulid";
import { PROACTIVITY_BUDGET } from "../budget.ts";
import type { GoalsService } from "../goals/service.ts";
import {
  cadenceKind,
  jobMarker,
  type LaunchResult,
  type ProactiveJob,
  parseJobMarker,
  type SchedulerLike,
} from "../jobs.ts";
import { type SqliteDatabase, toIso } from "../sqlite.ts";
import {
  effortMinutes,
  fitAcceptanceModel,
  type IdeaFeatures,
  type TrainingExample,
} from "./acceptance.ts";
import {
  type Candidate,
  findSequences,
  loadOwnerNotes,
  loadToolRuns,
  mineGoals,
  mineNotes,
  type SequenceOptions,
  type SignalsProvider,
  sequenceCandidates,
  signalCandidates,
} from "./mining.ts";
import { IdeaStore, type StoredIdea, toIdea } from "./store.ts";

/**
 * Ideas (features O7, O8; architecture §4.11; ADR-012; UI §3.10).
 *
 *   nightly mine job ─▶ miners (tool sequences, memory, goals, connector signals)
 *     ─▶ suppression (accepted / open / dismissed patterns, hidden sources, not-now snooze)
 *     ─▶ queued candidates (delivered_at NULL)
 *   delivery window job ─▶ refit the acceptance model on accept / dismiss history
 *     ─▶ keep candidates with p ≥ threshold, best first, at most `perWindow`
 *     ─▶ delivered (shown by `ideas.list`) + one `proactive` notification for the batch
 *   ideas.accept ─▶ a Task in the main thread (`createdFrom: idea`), or an Automation, or a goal
 *     check-in; ideas.dismiss ─▶ suppression + a training example
 *
 * Nothing here sends or writes outside Psyche: accepting creates a Task that runs under the
 * Permission Broker (drafts, not sends), or a disabled-by-nothing automation whose prompt is
 * template text. Mining itself is read-only over the owner's own data.
 */

export const IDEAS_MINE_JOB = "ideas-mine";
export const IDEAS_DELIVER_JOB = "ideas-deliver";
export const DEFAULT_MINE_SCHEDULE = "30 2 * * *";
export const DEFAULT_WINDOW_SCHEDULE = "0 9 * * *";
export const NOT_NOW_DAYS = 7;
export const MINING_WINDOW_DAYS = 30;

export type IdeaEvent = { event: "idea.updated"; payload: { idea: Idea } };

export interface IdeasServiceOptions {
  db: SqliteDatabase;
  clock: Clock;
  scheduler: SchedulerLike;
  tasks: Pick<TaskEngine, "create">;
  /** The owner's main thread: accepted ideas land there as task cards (O8). */
  mainThread: () => Promise<string>;
  memory?: Pick<MemoryStore, "listFiles" | "readFile">;
  goals?: GoalsService;
  notifier?: Pick<Notifier, "notify">;
  signals?: SignalsProvider;
  newId?: () => string;
  timezone?: string;
  onEvent?: (event: IdeaEvent) => void;
  perWindow?: number;
  minAcceptanceProb?: number;
  sequences?: SequenceOptions;
  onError?: (error: unknown) => void;
}

export interface MineReport {
  queued: StoredIdea[];
  suppressed: number;
  goalCandidates: number;
  errors: string[];
}

export interface AcceptParams {
  ideaId: string;
  recurring?: boolean;
  brief?: string;
  schedule?: string;
  timezone?: string;
  threadId?: string;
}

function featuresOf(i: Pick<StoredIdea, "kind" | "source" | "effort" | "evidence">): IdeaFeatures {
  return {
    kind: i.kind,
    source: i.source,
    effortMinutes: effortMinutes(i.effort),
    evidenceCount: i.evidence.length,
  };
}

/** Training examples from decided, delivered ideas (see `acceptance.ts` for the weights). */
export function trainingExamples(ideas: readonly StoredIdea[]): TrainingExample[] {
  const out: TrainingExample[] = [];
  for (const i of ideas) {
    if (i.deliveredAt === null) continue;
    const features = featuresOf(i);
    if (i.status === "accepted" || i.status === "edited")
      out.push({ features, label: 1, weight: 1 });
    else if (i.status === "dismissed") {
      out.push({ features, label: 0, weight: i.dismissReason === "not_now" ? 0.3 : 1 });
    } else if (i.status === "expired") out.push({ features, label: 0, weight: 0.2 });
  }
  return out;
}

export class IdeasService {
  readonly store: IdeaStore;
  readonly #o: IdeasServiceOptions;

  constructor(options: IdeasServiceOptions) {
    this.#o = options;
    this.store = new IdeaStore(options.db);
  }

  #now(): string {
    return toIso(this.#o.clock.now());
  }

  #id(): string {
    return this.#o.newId?.() ?? ulid(this.#o.clock.now());
  }

  #emit(idea: StoredIdea): void {
    this.#o.onEvent?.({ event: "idea.updated", payload: { idea: toIdea(idea) } });
  }

  #idea(id: string): StoredIdea {
    const i = this.store.get(id);
    if (i === undefined) throw new PsycheError("not_found", `idea ${id} not found`);
    return i;
  }

  /** The acceptance model refit on everything decided so far. */
  model() {
    return fitAcceptanceModel(trainingExamples(this.store.all()));
  }

  /** Accepted / (accepted + dismissed + expired) over delivered ideas: the ADR-012 metric. */
  stats(): {
    delivered: number;
    accepted: number;
    dismissed: number;
    expired: number;
    acceptanceRate: number | null;
  } {
    const delivered = this.store.all().filter((i) => i.deliveredAt !== null);
    const accepted = delivered.filter(
      (i) => i.status === "accepted" || i.status === "edited",
    ).length;
    const dismissed = delivered.filter((i) => i.status === "dismissed").length;
    const expired = delivered.filter((i) => i.status === "expired").length;
    const decided = accepted + dismissed + expired;
    return {
      delivered: delivered.length,
      accepted,
      dismissed,
      expired,
      acceptanceRate: decided === 0 ? null : Math.round((accepted / decided) * 1000) / 1000,
    };
  }

  // --- suppression -----------------------------------------------------------------------------

  /** Why a candidate is not queued, or `undefined` when it may be. */
  #suppressed(c: Candidate, history: readonly StoredIdea[], now: number): string | undefined {
    if (history.some((i) => i.source === c.source && i.dismissReason === "never_from_source")) {
      return "source hidden";
    }
    for (const i of history) {
      if (i.patternKey !== c.patternKey) continue;
      if (i.status === "proposed") return "already open";
      if (i.status === "accepted" || i.status === "edited") return "already accepted";
      if (i.status === "dismissed" && i.dismissReason !== "not_now") return "dismissed";
      const decided = i.decidedAt == null ? 0 : Date.parse(i.decidedAt);
      if (
        (i.status === "dismissed" || i.status === "expired") &&
        now - decided < NOT_NOW_DAYS * 86_400_000
      ) {
        return "snoozed";
      }
    }
    return undefined;
  }

  // --- mining ----------------------------------------------------------------------------------

  async mine(): Promise<MineReport> {
    const now = this.#o.clock.now();
    const candidates: Candidate[] = [];
    const errors: string[] = [];
    let goalCandidates = 0;
    const attempt = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        this.#o.onError?.(e);
        errors.push(`${name} failed`);
      }
    };
    await attempt("tools", async () => {
      const runs = loadToolRuns(this.#o.db, toIso(now - MINING_WINDOW_DAYS * 86_400_000));
      candidates.push(...sequenceCandidates(findSequences(runs, this.#o.sequences)));
    });
    if (this.#o.memory !== undefined) {
      const memory = this.#o.memory;
      await attempt("memory", async () => {
        const mined = mineNotes(await loadOwnerNotes(memory, now));
        candidates.push(...mined.tasks);
        // Wants become confirm-first goal candidates (the goals' own card), never ideas.
        for (const g of mined.goals) {
          const proposed = await this.#o.goals?.propose({ ...g, source: "memory" });
          if (proposed?.status === "candidate" && proposed.createdAt === toIso(now))
            goalCandidates += 1;
        }
      });
    }
    if (this.#o.goals !== undefined) {
      const goals = this.#o.goals;
      await attempt("goals", async () => {
        const states = [];
        for (const goal of await goals.list({ status: ["active"] })) {
          const detail = await goals.get(goal.id);
          states.push({ goal, milestones: detail.milestones, taskCount: detail.taskIds.length });
        }
        candidates.push(...mineGoals(states));
      });
    }
    if (this.#o.signals !== undefined) {
      const signals = this.#o.signals;
      await attempt("connectors", async () => {
        candidates.push(...signalCandidates(await signals()));
      });
    }

    const history = this.store.all();
    const model = fitAcceptanceModel(trainingExamples(history));
    const queued: StoredIdea[] = [];
    let suppressed = 0;
    const createdAt = toIso(now);
    for (const c of candidates) {
      if (this.#suppressed(c, [...history, ...queued], now) !== undefined) {
        suppressed += 1;
        continue;
      }
      const idea: StoredIdea = {
        ...c,
        id: this.#id(),
        acceptanceProb: model.predict(featuresOf(c)),
        status: "proposed",
        resultRef: null,
        createdAt,
        decidedAt: null,
        deliveredAt: null,
        dismissReason: null,
      };
      this.store.insert(idea);
      queued.push(idea);
    }
    return { queued, suppressed, goalCandidates, errors };
  }

  // --- delivery windows ------------------------------------------------------------------------

  /**
   * One delivery window: expire stale ideas, refit the model, deliver at most `perWindow`
   * queued ideas with p ≥ threshold, and raise one `proactive` notification for the batch.
   */
  async deliver(): Promise<{ delivered: StoredIdea[]; held: number; expired: number }> {
    const now = this.#o.clock.now();
    const expiry = PROACTIVITY_BUDGET.ideas.expiryDays * 86_400_000;
    let expired = 0;
    for (const i of this.store.all()) {
      if (i.status !== "proposed") continue;
      const since = Date.parse(i.deliveredAt ?? i.createdAt);
      if (now - since < expiry) continue;
      const next: StoredIdea = { ...i, status: "expired", decidedAt: toIso(now) };
      this.store.update(next);
      if (i.deliveredAt !== null) this.#emit(next);
      expired += 1;
    }
    const model = this.model();
    const threshold = this.#o.minAcceptanceProb ?? PROACTIVITY_BUDGET.ideas.minAcceptanceProb;
    const max = Math.min(
      this.#o.perWindow ?? PROACTIVITY_BUDGET.ideas.perWindow,
      PROACTIVITY_BUDGET.ideas.perWindow,
    );
    const scored = this.store
      .queued()
      .map((i) => ({ ...i, acceptanceProb: model.predict(featuresOf(i)) }))
      .sort(
        (a, b) =>
          b.acceptanceProb - a.acceptanceProb ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
    const delivered: StoredIdea[] = [];
    let held = 0;
    const at = toIso(now);
    for (const i of scored) {
      if (i.acceptanceProb < threshold || delivered.length >= max) {
        // Held for a later window (until it expires); its score is kept current.
        this.store.update(i);
        held += 1;
        continue;
      }
      const next: StoredIdea = { ...i, deliveredAt: at };
      this.store.update(next);
      delivered.push(next);
      this.#emit(next);
    }
    if (delivered.length > 0) {
      await this.#o.notifier?.notify({
        kind: "proactive",
        title: delivered.length === 1 ? "1 new idea" : `${delivered.length} new ideas`,
        body: delivered
          .map((i) => i.title)
          .join(" · ")
          .slice(0, 500),
        route: "/ideas",
        dedupeKey: "ideas:window",
      });
    }
    return { delivered, held, expired };
  }

  // --- read + decide ---------------------------------------------------------------------------

  async list(params: { status?: readonly Idea["status"][]; cursor?: string; limit?: number } = {}) {
    const page = this.store.page(params.status ?? ["proposed"], params);
    return { ideas: page.ideas.map(toIdea), nextCursor: page.nextCursor };
  }

  /** Accepting creates a Task card in chat, an Automation, or a goal check-in (O8). */
  async accept(
    params: AcceptParams,
  ): Promise<{ idea: Idea; taskId: string | null; automationId: string | null }> {
    const idea = this.#idea(params.ideaId);
    if (idea.status !== "proposed" || idea.deliveredAt === null) {
      throw new PsycheError("conflict", `idea ${idea.id} is not open`);
    }
    const brief = params.brief?.trim();
    const action = idea.action;
    let taskId: string | null = null;
    let automationId: string | null = null;
    let resultRef: string;
    const wantsAutomation =
      params.recurring === true || (action.type === "automation" && params.recurring !== false);
    if (action.type === "goal_cadence") {
      if (this.#o.goals === undefined)
        throw new PsycheError("unavailable", "goals are not configured");
      await this.#o.goals.update(action.goalId, {
        cadence: params.schedule ?? action.cadence,
        ...(params.timezone === undefined ? {} : { timezone: params.timezone }),
      });
      resultRef = `goal:${action.goalId}`;
    } else if (wantsAutomation) {
      // An automation prompt is an instruction for every future run: only template text or the
      // owner's own brief, never text that came from an untrusted source.
      const prompt = brief ?? (action.type === "automation" ? action.prompt : undefined);
      if (
        prompt === undefined ||
        (idea.untrusted && action.type !== "automation" && brief === undefined)
      ) {
        throw new PsycheError("conflict", "this idea cannot recur without a brief of your own");
      }
      const schedule =
        params.schedule ?? (action.type === "automation" ? action.schedule : undefined);
      if (schedule === undefined)
        throw new PsycheError("invalid_params", "a recurring idea needs a schedule");
      const automation = await this.#o.scheduler.create({
        kind: cadenceKind(schedule),
        title: action.title,
        schedule,
        timezone: params.timezone ?? this.#o.timezone ?? "UTC",
        sessionTarget: "isolated",
        delivery: {},
        prompt,
        enabled: true,
        scratch: null,
      });
      automationId = automation.id;
      resultRef = `automation:${automation.id}`;
    } else {
      const goal = brief ?? (action.type === "automation" ? action.taskGoal : action.goal);
      if (goal === undefined) throw new PsycheError("invalid_params", "a brief is required");
      const task = await this.#o.tasks.create({
        threadId: params.threadId ?? (await this.#o.mainThread()),
        title: action.title,
        goal,
        createdFrom: "idea",
        ...(idea.untrusted
          ? { taint: true, taintSources: [{ sourceKind: "idea", origin: idea.source }] }
          : {}),
      });
      taskId = task.id;
      resultRef = `task:${task.id}`;
    }
    const goalId = "goalId" in action ? action.goalId : undefined;
    if (
      goalId !== undefined &&
      this.#o.goals !== undefined &&
      (taskId !== null || automationId !== null)
    ) {
      try {
        await this.#o.goals.link({
          goalId,
          ...(taskId === null ? {} : { taskId }),
          ...(automationId === null ? {} : { automationId }),
        });
      } catch (e) {
        this.#o.onError?.(e);
      }
    }
    const next: StoredIdea = {
      ...idea,
      status: brief === undefined ? "accepted" : "edited",
      resultRef,
      decidedAt: this.#now(),
    };
    this.store.update(next);
    this.#emit(next);
    return { idea: toIdea(next), taskId, automationId };
  }

  /** Dismiss with a reason: suppresses the pattern (or source) and trains the model. */
  async dismiss(
    ideaId: string,
    reason: "not_now" | "not_interested" | "never_from_source",
  ): Promise<Idea> {
    const idea = this.#idea(ideaId);
    if (idea.status !== "proposed")
      throw new PsycheError("conflict", `idea ${idea.id} is not open`);
    const next: StoredIdea = {
      ...idea,
      status: "dismissed",
      dismissReason: reason,
      decidedAt: this.#now(),
    };
    this.store.update(next);
    this.#emit(next);
    return toIdea(next);
  }

  // --- schedules and jobs ----------------------------------------------------------------------

  async ensureSchedules(
    options: { mine?: string; windows?: string; timezone?: string; enabled?: boolean } = {},
  ) {
    const timezone = options.timezone ?? this.#o.timezone ?? "UTC";
    const all = await this.#o.scheduler.list();
    const upsert = async (job: string, title: string, schedule: string) => {
      const prompt = jobMarker(job, "nightly");
      const fields = {
        title,
        schedule,
        timezone,
        sessionTarget: "main",
        delivery: {},
        prompt,
        enabled: options.enabled ?? true,
        scratch: null,
      };
      const existing = all.find((a) => a.prompt.trim() === prompt);
      return existing === undefined
        ? this.#o.scheduler.create({ kind: "cron", system: true, ...fields })
        : this.#o.scheduler.update(existing.id, fields);
    };
    return {
      mine: await upsert(
        IDEAS_MINE_JOB,
        "Ideas: nightly mining",
        options.mine ?? DEFAULT_MINE_SCHEDULE,
      ),
      deliver: await upsert(
        IDEAS_DELIVER_JOB,
        "Ideas: delivery window",
        options.windows ?? DEFAULT_WINDOW_SCHEDULE,
      ),
    };
  }

  /** Both jobs, run in-process by `withProactiveJobs`. Each reports `no_reply`: it notifies itself at most once. */
  job(): ProactiveJob {
    return {
      name: "ideas",
      matches: (a) => {
        const job = parseJobMarker(a.prompt)?.job;
        return job === IDEAS_MINE_JOB || job === IDEAS_DELIVER_JOB;
      },
      run: async (request): Promise<LaunchResult> => {
        if (parseJobMarker(request.automation.prompt)?.job === IDEAS_MINE_JOB) {
          const r = await this.mine();
          return {
            status: r.errors.length > 0 && r.queued.length === 0 ? "failed" : "no_reply",
            summary: `queued ${r.queued.length}, suppressed ${r.suppressed}, goal candidates ${r.goalCandidates}${r.errors.length === 0 ? "" : `; ${r.errors.join(", ")}`}`,
          };
        }
        const r = await this.deliver();
        return {
          status: "no_reply",
          summary: `delivered ${r.delivered.length}, held ${r.held}, expired ${r.expired}`,
        };
      },
    };
  }
}
