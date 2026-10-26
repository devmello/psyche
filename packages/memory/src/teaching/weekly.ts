import type { Clock, FeedbackEvent, GrowthCard, GrowthCardItem } from "@psyche/protocol";
import type { SqliteMemoryStore } from "../store.ts";
import { confidenceWords } from "./confidence.ts";
import { lessonFlags } from "./consolidate.ts";
import type { TeachingService } from "./service.ts";
import { LIVE_STATUSES, type StoredLesson, type TeachingStore, weekOf } from "./store.ts";

/**
 * The weekly "What I learned" card (docs/agent/teaching-loop-2026.md §5.4): a review queue, not a
 * celebration. At most seven items, in this order:
 *
 * - **lesson**: lessons learned this week, each with its "Because:" line (the owner's words);
 * - **conflict**: lessons dreaming flagged as contradicted or narrowed by a later one;
 * - **question**: the same implicit signal three times in 30 days (heavy edits to a skill's
 *   drafts, quick cancels, narrower approvals, denials, dismissed ideas or posts), phrased as the
 *   lesson "Yes, remember" would teach; never asked again for four weeks;
 * - **retire**: lessons not used for 60 days ("Still true?"), asked once per four weeks.
 *
 * Nothing to say → no card. One card per week (Monday-based, `weekOf`).
 */

const DAY_MS = 86_400_000;
const MAX_ITEMS = 7;
const MAX_NEW_LESSONS = 3;
const QUESTION_MIN = 3;
const QUESTION_WINDOW_DAYS = 30;
const RETIRE_AFTER_DAYS = 60;
const ASK_AGAIN_DAYS = 28;
/** A "Still true?" left unanswered this long moves the lesson to dormant (§3.3, §5.4). */
export const RETIRE_UNANSWERED_DAYS = 14;
const LEDGER_KEY = "teaching.weekly";

interface Ledger {
  /** The week of the last card posted. */
  lastWeekOf?: string;
  /** Question keys and lesson ids already asked, with when. */
  asked: Record<string, string>;
  /** Flags already shown (lesson id → flag time). */
  shownFlags: Record<string, string>;
}

export interface WeeklyCard {
  title: string;
  bodyMd: string;
  growth: GrowthCard;
}

const clip = (s: string, n = 300) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1).trimEnd()}…`;
};

const human = (kind: string) => kind.replace(/_/g, " ");

/** The lesson a group of implicit signals points at, and its key; `undefined` when none. */
function questionFor(e: FeedbackEvent): { key: string; statement: string } | undefined {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  const skill = e.target.skill;
  switch (e.kind) {
    case "draft_edited":
      return skill === undefined
        ? { key: "draft:any", statement: "Write drafts closer to how you usually edit them" }
        : {
            key: `draft:${skill}`,
            statement: `Write ${skill} drafts closer to how you usually edit them`,
          };
    case "undo":
      return {
        key: `undo:${skill ?? e.target.type}`,
        statement:
          skill === undefined
            ? "Check with you before starting tasks like the ones you cancelled"
            : `Check with you before running ${skill} the way you cancelled it`,
      };
    case "approval_edited":
      return typeof d.approvalKind === "string" && d.chosen === "once"
        ? {
            key: `approval:${d.approvalKind}`,
            statement: `Ask each time before ${human(d.approvalKind)} actions instead of offering standing permission`,
          }
        : undefined;
    case "approval_denied":
      return typeof d.approvalKind === "string"
        ? {
            key: `denied:${d.approvalKind}`,
            statement: `Don't propose ${human(d.approvalKind)} actions unless you ask`,
          }
        : undefined;
    case "idea":
      return typeof d.kind === "string"
        ? { key: `idea:${d.kind}`, statement: `Suggest fewer ${human(d.kind)} ideas` }
        : undefined;
    case "feed":
      return d.feedback === "not_interested" || d.feedback === "hide_source"
        ? { key: "feed", statement: "Show fewer posts like the ones you dismissed" }
        : undefined;
    default:
      return undefined;
  }
}

function because(store: TeachingStore, l: StoredLesson): string {
  const first = store.eventsFor(l.sources)[0];
  const words = first?.text ?? first?.reason?.replace(/_/g, " ");
  return clip(words === undefined || words === null ? confidenceWords(l) : `You said: “${words}”`);
}

const monthDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/**
 * The card for this week, or `undefined` when there is nothing to say or it was already posted.
 * Records what it asked (call only when the card is actually posted).
 */
export function buildWeeklyCard(
  store: TeachingStore,
  memory: SqliteMemoryStore,
  options: { clock?: Clock } = {},
): WeeklyCard | undefined {
  const nowMs = (options.clock ?? { now: () => Date.now() }).now();
  const now = new Date(nowMs).toISOString();
  const week = weekOf(now);
  const ledger: Ledger = {
    asked: {},
    shownFlags: {},
    ...(memory.getState<Ledger>(LEDGER_KEY) ?? {}),
  };
  if (ledger.lastWeekOf === week) return undefined;
  const askedRecently = (key: string) => {
    const at = ledger.asked[key];
    return at !== undefined && nowMs - Date.parse(at) < ASK_AGAIN_DAYS * DAY_MS;
  };
  const live = store.listLessons({ status: LIVE_STATUSES, limit: 500 }).lessons;
  const byId = new Map(live.map((l) => [l.id, l]));
  const items: GrowthCardItem[] = [];

  // New lessons this week.
  const weekAgo = new Date(nowMs - 7 * DAY_MS).toISOString();
  for (const l of live
    .filter((x) => x.createdAt >= weekAgo)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_NEW_LESSONS)) {
    items.push({
      type: "lesson",
      statement: clip(l.statement),
      because: because(store, l),
      lessonId: l.id,
      evidence: l.sources.slice(0, 20),
    });
  }

  // Conflicts dreaming found, once each.
  for (const f of lessonFlags(memory)) {
    const l = byId.get(f.lessonId);
    const by = byId.get(f.byLessonId);
    if (l === undefined || by === undefined || ledger.shownFlags[f.lessonId] === f.at) continue;
    items.push({
      type: "conflict",
      statement: clip(l.statement),
      because: clip(`A later lesson may change this: ${by.statement}`),
      lessonId: l.id,
      evidence: [],
    });
    ledger.shownFlags[f.lessonId] = f.at;
  }

  // Questions from repeated implicit evidence nobody turned into a lesson.
  const since = new Date(nowMs - QUESTION_WINDOW_DAYS * DAY_MS).toISOString();
  const groups = new Map<string, { statement: string; events: FeedbackEvent[] }>();
  for (const e of store.listEvents({ since, limit: 500 }).events) {
    if (e.lessonId != null) continue;
    const q = questionFor(e);
    if (q === undefined) continue;
    const g = groups.get(q.key) ?? { statement: q.statement, events: [] };
    g.events.push(e);
    groups.set(q.key, g);
  }
  for (const [key, g] of groups) {
    if (g.events.length < QUESTION_MIN || askedRecently(`q:${key}`)) continue;
    items.push({
      type: "question",
      statement: clip(g.statement),
      because: `Noticed ${g.events.length} times in the last ${QUESTION_WINDOW_DAYS} days`,
      lessonId: null,
      evidence: g.events.slice(0, 20).map((e) => e.id),
    });
    ledger.asked[`q:${key}`] = now;
  }

  // Lessons not used in a long time.
  const stale = new Date(nowMs - RETIRE_AFTER_DAYS * DAY_MS).toISOString();
  for (const l of live) {
    const last = l.lastAppliedAt ?? l.lastConfirmedAt ?? l.createdAt;
    if (last >= stale || askedRecently(`r:${l.id}`)) continue;
    items.push({
      type: "retire",
      statement: clip(l.statement),
      because: `Still true? I haven't used this since ${monthDay(last)}`,
      lessonId: l.id,
      evidence: [],
    });
    ledger.asked[`r:${l.id}`] = now;
  }

  const shown = items.slice(0, MAX_ITEMS);
  if (shown.length === 0) return undefined;
  ledger.lastWeekOf = week;
  memory.setState(LEDGER_KEY, ledger);
  const count = (t: GrowthCardItem["type"]) => shown.filter((i) => i.type === t).length;
  const parts = [
    count("lesson") > 0
      ? `${count("lesson")} new ${count("lesson") === 1 ? "lesson" : "lessons"}`
      : "",
    count("question") > 0
      ? `${count("question")} ${count("question") === 1 ? "question" : "questions"} for you`
      : "",
    count("conflict") > 0 ? `${count("conflict")} to check` : "",
    count("retire") > 0 ? `${count("retire")} I haven't used lately` : "",
  ].filter(Boolean);
  return {
    title: "What I learned this week",
    bodyMd: `${parts.join(", ")}. Keep, edit or forget each one below.`,
    growth: { weekOf: week, items: shown },
  };
}

/**
 * The nightly half of ageing (§3.3): a lesson the weekly card asked "Still true?" about that
 * nobody answered within `RETIRE_UNANSWERED_DAYS` (no Keep, edit or use since, not forgotten)
 * goes dormant through `TeachingService.retire`. Returns how many did.
 */
export async function retireUnanswered(
  service: TeachingService,
  memory: SqliteMemoryStore,
  options: { clock?: Clock } = {},
): Promise<number> {
  const nowMs = (options.clock ?? { now: () => Date.now() }).now();
  const ledger: Ledger = {
    asked: {},
    shownFlags: {},
    ...(memory.getState<Ledger>(LEDGER_KEY) ?? {}),
  };
  let retired = 0;
  let changed = false;
  for (const [key, askedAt] of Object.entries(ledger.asked)) {
    if (!key.startsWith("r:")) continue;
    if (nowMs - Date.parse(askedAt) < RETIRE_UNANSWERED_DAYS * DAY_MS) continue;
    const lesson = service.store.getLesson(key.slice(2));
    const answered =
      lesson === undefined ||
      !LIVE_STATUSES.includes(lesson.status) ||
      [lesson.lastConfirmedAt, lesson.lastAppliedAt, lesson.updatedAt].some(
        (t) => t != null && t > askedAt,
      );
    delete ledger.asked[key];
    changed = true;
    if (answered || (lesson.destination.type !== "file" && lesson.destination.type !== "skill"))
      continue;
    await service.retire(lesson.id);
    retired++;
  }
  if (changed) memory.setState(LEDGER_KEY, ledger);
  return retired;
}
