import type {
  FeedbackEvent,
  GrantScope,
  GrowthItem,
  GrowthMetric,
  GrowthSummary,
  GrowthWindow,
  Lesson,
  Milestone,
} from "@psyche/protocol";
import { publicLesson } from "./service.ts";
import { type StoredLesson, weekOf } from "./store.ts";

/**
 * `growth.summary` (docs/agent/teaching-loop-2026.md §3.4): how the agent grew for the owner,
 * computed, never stored. Every number compares the agent with its own previous window, comes
 * with its count, and stays null below 10 events ("Not enough history yet"); every number opens
 * into the lessons and feedback behind it. No scores, levels, streaks or ranks: milestones are
 * dated facts.
 */

/** Rates need at least this many events (§3.4 "Metrics are shown only with enough data"). */
export const MIN_EVENTS_FOR_RATE = 10;
const DAY = 86_400_000;
const WINDOW_DAYS: Record<Exclude<GrowthWindow, "all">, number> = { "7d": 7, "30d": 30 };
const TIMELINE_MAX = 100;
const EVIDENCE_MAX = 50;

export interface GrowthApproval {
  id: string;
  kind: string;
  status: string;
  decidedAt: string | null;
  scopesOffered: readonly GrantScope[];
  scopeGranted: GrantScope | null;
  /** A lesson's own card: not an outcome of the agent's proposals. */
  fromLesson?: unknown;
}

export interface GrowthTask {
  id: string;
  status: string;
  completedAt: string | null;
  skill?: string;
}

export interface GrowthAutomation {
  id: string;
  title: string;
  createdAt: string;
  system?: boolean;
}

export interface GrowthData {
  now: number;
  events: readonly FeedbackEvent[];
  lessons: readonly StoredLesson[];
  /** `feedback_weekly` rows; `draft_sent` counts every agent draft the owner sent. */
  weekly: readonly { week: string; kind: string; count: number }[];
  approvals: readonly GrowthApproval[];
  tasks: readonly GrowthTask[];
  automations: readonly GrowthAutomation[];
  /** When the owner started with the agent (the first thread), for the first week / month. */
  startedAt?: string | null;
  /** Skills the owner accepted from a routine draft, for that milestone. */
  skillsFromRoutines?: readonly { name: string; acceptedAt: string }[];
}

const SCOPE_RANK: Record<GrantScope, number> = { once: 0, task: 1, site: 2, session: 2, always: 3 };

interface Range {
  from: number;
  to: number;
}

function inRange(iso: string | null | undefined, r: Range): boolean {
  if (iso == null) return false;
  const t = Date.parse(iso);
  return t >= r.from && t < r.to;
}

/** Explicit feedback that can teach (a correction, a reason chip, a redo instruction). */
export function isCorrection(e: FeedbackEvent): boolean {
  if (e.kind === "correction") return true;
  if (e.kind === "not_helpful") return (e.text ?? "") !== "" || e.reason != null;
  return e.kind === "regenerated" && (e.text ?? "") !== "";
}

/** Lessons that were written at their destination (not declined, not still waiting). */
function written(l: StoredLesson): boolean {
  return l.status !== "proposed" && l.status !== "dormant";
}

function rate(count: number, total: number): number | null {
  return total >= MIN_EVENTS_FOR_RATE ? Math.round((count / total) * 1000) / 1000 : null;
}

function metric(
  id: GrowthMetric["id"],
  current: { count: number; total: number; evidence: string[] },
  previous: { count: number; total: number } | null,
  skill?: string,
): GrowthMetric {
  return {
    id,
    ...(skill === undefined ? {} : { skill }),
    count: current.count,
    total: current.total,
    rate: rate(current.count, current.total),
    previousCount: previous?.count ?? null,
    previousTotal: previous?.total ?? null,
    previousRate: previous === null ? null : rate(previous.count, previous.total),
    evidence: current.evidence.slice(0, EVIDENCE_MAX),
  };
}

function newestFirst<T extends { createdAt: string }>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function outcomes(d: GrowthData, r: Range) {
  const events = newestFirst(d.events.filter((e) => inRange(e.createdAt, r)));
  const byId = new Map(d.lessons.map((l) => [l.id, l]));
  const corrections = events.filter(isCorrection);
  const applied = corrections.filter((e) => e.lessonId != null);
  // A correction on a destination that already had a lesson: it refined one, or repeated one.
  const repeats = applied.filter((e) => {
    const l = byId.get(e.lessonId as string);
    if (l === undefined) return false;
    if (l.refinedCount > 0 && l.sources[0] === e.id) return true;
    return l.sources.indexOf(e.id) > 0;
  });
  const startWeek = weekOf(new Date(Number.isFinite(r.from) ? r.from : 0).toISOString());
  const endWeek = weekOf(new Date(r.to).toISOString());
  const sent = d.weekly
    .filter((w) => w.kind === "draft_sent" && w.week >= startWeek && w.week <= endWeek)
    .reduce((n, w) => n + w.count, 0);
  const edited = events.filter((e) => e.kind === "draft_edited");
  const decided = d.approvals.filter(
    (a) =>
      a.fromLesson === undefined &&
      a.kind !== "plan_exit" &&
      (a.status === "approved" || a.status === "denied") &&
      inRange(a.decidedAt, r),
  );
  const unchanged = decided.filter((a) => {
    if (a.status !== "approved") return false;
    const widest = Math.max(...a.scopesOffered.map((s) => SCOPE_RANK[s]));
    return (a.scopeGranted === null ? 0 : SCOPE_RANK[a.scopeGranted]) >= widest;
  });
  const approvalEvidence = events
    .filter((e) => e.kind === "approval_edited" || e.kind === "approval_denied")
    .map((e) => e.id);
  const finished = d.tasks.filter(
    (t) =>
      (t.status === "done" || t.status === "failed" || t.status === "cancelled") &&
      inRange(t.completedAt, r),
  );
  const skills = [
    ...new Set(finished.flatMap((t) => (t.skill === undefined ? [] : [t.skill]))),
  ].sort();
  return {
    corrections_applied: {
      count: applied.length,
      total: corrections.length,
      evidence: applied.map((e) => e.lessonId as string),
    },
    repeat_corrections: {
      count: repeats.length,
      total: applied.length,
      evidence: repeats.map((e) => e.id),
    },
    drafts_sent_as_is: {
      count: Math.max(0, sent - edited.length),
      total: Math.max(sent, edited.length),
      evidence: edited.map((e) => e.id),
    },
    approvals_without_change: {
      count: unchanged.length,
      total: decided.length,
      evidence: approvalEvidence,
    },
    task_success: {
      count: finished.filter((t) => t.status === "done").length,
      total: finished.length,
      evidence: [] as string[],
    },
    perSkill: skills.map((skill) => {
      const mine = finished.filter((t) => t.skill === skill);
      return {
        skill,
        count: mine.filter((t) => t.status === "done").length,
        total: mine.length,
        evidence: [] as string[],
      };
    }),
  };
}

/** Dated facts, oldest first (§3.4 "Milestones": moments, not streaks). */
export function milestones(d: GrowthData): Milestone[] {
  const out: Milestone[] = [];
  const add = (kind: Milestone["kind"], at: string, subject: string | null, ref: string | null) =>
    out.push({ kind, at, subject, ref });
  const now = d.now;
  if (d.startedAt != null) {
    const start = Date.parse(d.startedAt);
    if (now >= start + 7 * DAY)
      add("first_week", new Date(start + 7 * DAY).toISOString(), null, null);
    if (now >= start + 30 * DAY)
      add("first_month", new Date(start + 30 * DAY).toISOString(), null, null);
  }
  const learned = [...d.lessons]
    .filter(written)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const first = learned[0];
  if (first !== undefined) {
    add(
      "first_lesson",
      first.createdAt,
      first.status === "forgotten" ? null : first.statement,
      first.status === "forgotten" ? null : first.id,
    );
  }
  const tenth = learned[9];
  if (tenth !== undefined) add("lessons_10", tenth.createdAt, null, null);
  const done = d.tasks
    .filter((t) => t.status === "done" && t.completedAt != null)
    .map((t) => t.completedAt as string)
    .sort();
  if (done.length >= 100) add("tasks_100", done[99] as string, null, null);
  const auto = [...d.automations]
    .filter((a) => a.system !== true)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (auto !== undefined)
    add("first_automation", auto.createdAt, auto.title.slice(0, 200), auto.id);
  const skill = [...(d.skillsFromRoutines ?? [])].sort((a, b) =>
    a.acceptedAt.localeCompare(b.acceptedAt),
  )[0];
  if (skill !== undefined) add("first_skill_from_routine", skill.acceptedAt, skill.name, null);
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function computeGrowth(window: GrowthWindow, d: GrowthData): GrowthSummary {
  const to = d.now + 1;
  const current: Range =
    window === "all"
      ? { from: Number.NEGATIVE_INFINITY, to }
      : { from: d.now - WINDOW_DAYS[window] * DAY, to };
  const previous: Range | null =
    window === "all" ? null : { from: current.from - WINDOW_DAYS[window] * DAY, to: current.from };
  const now = outcomes(d, current);
  const before = previous === null ? null : outcomes(d, previous);
  const metrics: GrowthMetric[] = [
    metric("corrections_applied", now.corrections_applied, before?.corrections_applied ?? null),
    metric("repeat_corrections", now.repeat_corrections, before?.repeat_corrections ?? null),
    metric("drafts_sent_as_is", now.drafts_sent_as_is, before?.drafts_sent_as_is ?? null),
    metric(
      "approvals_without_change",
      now.approvals_without_change,
      before?.approvals_without_change ?? null,
    ),
    metric("task_success", now.task_success, before?.task_success ?? null),
    ...now.perSkill.map((s) =>
      metric("task_success", s, before?.perSkill.find((p) => p.skill === s.skill) ?? null, s.skill),
    ),
  ];

  const learnedHere = d.lessons.filter((l) => written(l) && inRange(l.createdAt, current));
  const lessons = {
    learned: learnedHere.length,
    refined: learnedHere.filter((l) => l.refinedCount > 0).length,
    confirmed: d.lessons.filter((l) => inRange(l.confirmedAt, current)).length,
    forgotten: d.lessons.filter((l) => inRange(l.forgottenAt, current)).length,
  };
  const all = milestones(d);
  const timeline: GrowthItem[] = [
    ...learnedHere
      .filter((l) => l.status !== "forgotten")
      .map(
        (l): GrowthItem => ({ type: "lesson", at: l.createdAt, lesson: publicLesson(l) as Lesson }),
      ),
    ...all
      .filter((m) => inRange(m.at, current))
      .map((m): GrowthItem => ({ type: "milestone", at: m.at, milestone: m })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, TIMELINE_MAX);
  const firsts = [...d.events.map((e) => e.createdAt), ...d.lessons.map((l) => l.createdAt)].sort();
  return { window, lessons, metrics, milestones: all, timeline, since: firsts[0] ?? null };
}
