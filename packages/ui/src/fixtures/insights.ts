import type { GrowthWindow, InsightDay, InsightTotals, MethodResult } from "@psyche/protocol";
import { FIXTURE_NOW } from "./ids.ts";

/**
 * `insights.summary` fixtures (docs/design/agent-overview-2026.md §6.2): a new user on day 2, a
 * typical month, and a heavy all-time year. Generated from a seeded counter, so stories and
 * baselines never change between runs. Days end on the fixture clock's day (UTC).
 */

type InsightsSummary = MethodResult<"insights.summary">;
export type InsightsFixtureState = "new" | "typical" | "heavy";

const DAY_MS = 86_400_000;
const TODAY = FIXTURE_NOW.slice(0, 10);

const shift = (key: string, delta: number): string =>
  new Date(Date.parse(`${key}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Profile {
  /** Days of history before and including today. */
  history: number;
  /** Mean runs on a weekday, and how much weekends keep. */
  perDay: number;
  weekend: number;
  /** Chance a run fails. */
  failRate: number;
  seed: number;
}

const PROFILES: Record<InsightsFixtureState, Profile> = {
  new: { history: 2, perDay: 4, weekend: 1, failRate: 0, seed: 11 },
  typical: { history: 60, perDay: 6, weekend: 0.35, failRate: 0.06, seed: 23 },
  heavy: { history: 371, perDay: 16, weekend: 0.5, failRate: 0.04, seed: 47 },
};

/** Every day from `history` days ago to today, oldest first. */
function allDays(profile: Profile): InsightDay[] {
  const next = rng(profile.seed);
  return Array.from({ length: profile.history }, (_, i) => {
    const date = shift(TODAY, -(profile.history - 1 - i));
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const base = profile.perDay * (weekend ? profile.weekend : 1);
    const n = Math.max(0, Math.round(base * (0.4 + next() * 1.2)));
    const automation = Math.round(n * 0.3);
    const task = Math.round(n * 0.25);
    const chat = Math.max(0, n - automation - task);
    const failed = Array.from({ length: n }).filter(() => next() < profile.failRate).length;
    const wallMs = Math.round(n * (40_000 + next() * 90_000));
    return { date, runs: { task, chat, automation }, failed, wallMs };
  });
}

function totalsOf(days: readonly InsightDay[], scale: number): InsightTotals {
  const sum = (pick: (d: InsightDay) => number) => days.reduce((n, d) => n + pick(d), 0);
  const task = sum((d) => d.runs.task);
  const chat = sum((d) => d.runs.chat);
  const automation = sum((d) => d.runs.automation);
  const failed = sum((d) => d.failed);
  const runs = task + chat + automation;
  let busiest: InsightTotals["busiestDay"] = null;
  for (const d of days) {
    const n = d.runs.task + d.runs.chat + d.runs.automation;
    if (n > 0 && (busiest === null || n >= busiest.runs)) busiest = { date: d.date, runs: n };
  }
  const k = (n: number) => Math.round(n * scale);
  return {
    runs: { task, chat, automation, subagent: k(task * 0.6) },
    runsDone: runs - failed,
    runsFailed: failed,
    wallMs: sum((d) => d.wallMs),
    approvals: { approved: k(runs * 0.35), denied: k(runs * 0.02), expired: k(runs * 0.01) },
    artifacts: { created: k(runs * 0.12), versions: k(runs * 0.3), charts: k(runs * 0.03) },
    specialists: { done: k(task * 0.5), partial: k(task * 0.06), failed: k(task * 0.03) },
    busiestDay: busiest,
    topAutomation:
      automation === 0
        ? null
        : {
            automationId: "auto_morning_brief",
            title: "Morning brief",
            runs: Math.min(automation, Math.max(1, Math.round(days.length * 0.9))),
          },
  };
}

const PEOPLE: ReadonlyArray<{ name: string; kind: "person" | "org" | "project" }> = [
  { name: "Maya Chen", kind: "person" },
  { name: "Northwind", kind: "org" },
  { name: "Q4 launch", kind: "project" },
  { name: "Dev Patel", kind: "person" },
  { name: "Sam Ortiz", kind: "person" },
  { name: "Lumen Labs", kind: "org" },
  { name: "Ana Souza", kind: "person" },
  { name: "Website refresh", kind: "project" },
  { name: "Jonas Weber", kind: "person" },
  { name: "Kestrel Bank", kind: "org" },
  { name: "Priya Nair", kind: "person" },
  { name: "Taxes 2026", kind: "project" },
  { name: "Leo Martin", kind: "person" },
];

function entities(count: number, top: number): InsightsSummary["topEntities"] {
  return PEOPLE.slice(0, count).map((p, i) => ({
    entityId: `ent_insights_${i + 1}`,
    kind: p.kind,
    name: p.name,
    interactions: Math.max(1, Math.round(top / (1 + i * 0.55))),
    lastInteractionAt: new Date(Date.parse(FIXTURE_NOW) - (i * 7 + 2) * 3_600_000).toISOString(),
    openLoops: i % 3 === 0 ? 2 : i % 4 === 1 ? 1 : 0,
  }));
}

/** The three windows of one state, as `insights.summary` would answer them at the fixture clock. */
export function insightsFixtures(
  state: InsightsFixtureState,
): Record<GrowthWindow, InsightsSummary> {
  const profile = PROFILES[state];
  const days = allDays(profile);
  const first =
    state === "new"
      ? "2026-10-17T14:05:00.000Z"
      : `${shift(TODAY, -(profile.history - 1))}T09:30:00.000Z`;
  const topCount = state === "new" ? 2 : state === "typical" ? 8 : 12;
  const topBase = state === "new" ? 2 : state === "typical" ? 14 : 120;
  const build = (window: GrowthWindow, span: number): InsightsSummary => {
    const slice = days.slice(-span);
    const from = window === "all" ? first : `${slice[0]?.date ?? TODAY}T00:00:00.000Z`;
    const periodDays = window === "all" ? days : slice;
    const before = days.slice(-span * 2, -span);
    const range = { from, to: FIXTURE_NOW.replace("Z", ".000Z") };
    const shown = window === "all" ? days.slice(-371) : slice;
    // Pad a short history with empty days, as the Gateway does (zeros included).
    const pad = Math.max(0, (window === "all" ? 371 : span) - shown.length);
    const zeros: InsightDay[] = Array.from({ length: pad }, (_, i) => ({
      date: shift(shown[0]?.date ?? TODAY, -(pad - i)),
      runs: { task: 0, chat: 0, automation: 0 },
      failed: 0,
      wallMs: 0,
    }));
    return {
      window,
      range,
      firstActivityAt: first,
      totals: totalsOf(periodDays, state === "new" ? 0.2 : 1),
      previous: window === "all" ? null : totalsOf(before, 0.85),
      days: [...zeros, ...shown],
      topEntities: entities(topCount, window === "7d" ? Math.ceil(topBase / 4) : topBase),
    };
  };
  return { "7d": build("7d", 7), "30d": build("30d", 30), all: build("all", 371) };
}

/** What the Gateway answers before anything has happened: zeros and a null first activity. */
export function emptyInsights(window: GrowthWindow): InsightsSummary {
  const span = window === "7d" ? 7 : window === "30d" ? 30 : 371;
  const zero = totalsOf([], 0);
  return {
    window,
    range: { from: `${shift(TODAY, -(span - 1))}T00:00:00.000Z`, to: FIXTURE_NOW },
    firstActivityAt: null,
    totals: zero,
    previous: window === "all" ? null : zero,
    days: Array.from({ length: span }, (_, i) => ({
      date: shift(TODAY, -(span - 1 - i)),
      runs: { task: 0, chat: 0, automation: 0 },
      failed: 0,
      wallMs: 0,
    })),
    topEntities: [],
  };
}
