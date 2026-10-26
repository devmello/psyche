import type { PsycheDb } from "@psyche/db";
import {
  type InsightDay,
  type InsightEntity,
  type InsightTotals,
  type MethodParams,
  type MethodResult,
  PsycheError,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";

/**
 * `insights.summary` (docs/design/agent-overview-2026.md §6.2): the Overview's aggregates, read
 * from tables that already exist (runs, approvals, artifacts and versions, specialist jobs, graph
 * interactions). Read-only, no migration, no events. Runs from incognito threads are left out, as
 * memory leaves them out; days are counted in the caller's time zone.
 */

export interface InsightsSetup {
  db: PsycheDb;
  now?: () => Date;
}

const DAY_MS = 86_400_000;
const WINDOW_DAYS = { "7d": 7, "30d": 30 } as const;
/** `all` returns the last 53 weeks of days: one heatmap, week columns. */
const ALL_DAYS = 53 * 7;
const MAX_ENTITIES = 12;

/** `YYYY-MM-DD` of `date` in `timeZone`. */
function dayIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** `key` moved by `delta` calendar days (no time zone involved, so DST cannot repeat a day). */
function shiftDay(key: string, delta: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** The UTC offset of `timeZone` at `at`, in ms (positive east of Greenwich). */
function offsetAt(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant a calendar day starts in `timeZone`. */
function startOfDay(key: string, timeZone: string): Date {
  const guess = Date.parse(`${key}T00:00:00Z`);
  let t = guess - offsetAt(guess, timeZone);
  // Across a DST change the first guess can be an hour off; one more pass settles it.
  t = guess - offsetAt(t, timeZone);
  return new Date(t);
}

type RunKind = "task" | "chat" | "automation" | "subagent";

interface RunRow {
  kind: RunKind;
  status: string;
  startedAt: string;
  endedAt: string | null;
}

interface DayTally {
  task: number;
  chat: number;
  automation: number;
  failed: number;
  wallMs: number;
}

const KIND_SQL = `COALESCE(r.kind, CASE
  WHEN r.automation_run_id IS NOT NULL THEN 'automation'
  WHEN r.parent_run_id IS NOT NULL THEN 'subagent'
  WHEN r.task_id IS NOT NULL THEN 'task'
  ELSE 'chat' END)`;

/** Excludes rows whose thread is incognito. `col` is the thread id column, null counts as none. */
const notIncognito = (col: string) =>
  `NOT EXISTS (SELECT 1 FROM threads _t WHERE _t.id = ${col} AND _t.kind = 'incognito')`;

function wallOf(row: RunRow): number {
  if (row.endedAt === null) return 0;
  const ms = Date.parse(row.endedAt) - Date.parse(row.startedAt);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function emptyTotals(): InsightTotals {
  return {
    runs: { task: 0, chat: 0, automation: 0, subagent: 0 },
    runsDone: 0,
    runsFailed: 0,
    wallMs: 0,
    approvals: { approved: 0, denied: 0, expired: 0 },
    artifacts: { created: 0, versions: 0, charts: 0 },
    specialists: { done: 0, partial: 0, failed: 0 },
    busiestDay: null,
    topAutomation: null,
  };
}

export function insightsHandlers(setup: InsightsSetup): Record<string, HandlerDef> {
  const sql = setup.db.sqlite;

  /** Runs started in [from, to) as light rows, oldest first. */
  function runRows(from: string | null, to: string): RunRow[] {
    return sql
      .prepare(
        `SELECT ${KIND_SQL} AS kind, r.status AS status, r.started_at AS startedAt,
                r.ended_at AS endedAt
         FROM runs r
         WHERE ${from === null ? "1 = 1" : "r.started_at >= @from"} AND r.started_at < @to
           AND ${notIncognito("r.thread_id")}
         ORDER BY r.started_at`,
      )
      .all({ ...(from === null ? {} : { from }), to }) as RunRow[];
  }

  /** Per-day tallies of `rows`, bucketed in `timeZone`. */
  function bucket(rows: readonly RunRow[], timeZone: string): Map<string, DayTally> {
    const days = new Map<string, DayTally>();
    for (const row of rows) {
      const key = dayIn(new Date(row.startedAt), timeZone);
      let d = days.get(key);
      if (d === undefined) {
        d = { task: 0, chat: 0, automation: 0, failed: 0, wallMs: 0 };
        days.set(key, d);
      }
      if (row.kind !== "subagent") d[row.kind] += 1;
      if (row.status === "failed") d.failed += 1;
      d.wallMs += wallOf(row);
    }
    return days;
  }

  /** The non-run counts of one period, plus the runs' totals from their rows. */
  function totalsFor(
    rows: readonly RunRow[],
    days: Map<string, DayTally>,
    from: string | null,
    to: string,
  ): InsightTotals {
    const t = emptyTotals();
    for (const row of rows) {
      t.runs[row.kind] += 1;
      if (row.status === "done") t.runsDone += 1;
      if (row.status === "failed") t.runsFailed += 1;
      t.wallMs += wallOf(row);
    }
    let busiest: { date: string; runs: number } | null = null;
    for (const [date, d] of days) {
      // Days arrive oldest first, so a tie goes to the most recent day.
      const runs = d.task + d.chat + d.automation;
      if (runs > 0 && (busiest === null || runs >= busiest.runs)) busiest = { date, runs };
    }
    t.busiestDay = busiest;
    const lower = (col: string) => (from === null ? "1 = 1" : `${col} >= @from`);
    const bind = from === null ? { to } : { from, to };

    const approvals = sql
      .prepare(
        `SELECT status, COUNT(*) AS n FROM approvals a
         WHERE status IN ('approved', 'denied', 'expired')
           AND ${lower("COALESCE(a.decided_at, a.expires_at)")}
           AND COALESCE(a.decided_at, a.expires_at) < @to
           AND ${notIncognito("a.thread_id")}
         GROUP BY status`,
      )
      .all(bind) as { status: "approved" | "denied" | "expired"; n: number }[];
    for (const r of approvals) t.approvals[r.status] = r.n;

    const created = sql
      .prepare(
        `SELECT COUNT(*) AS created, COALESCE(SUM(a.type = 'chart'), 0) AS charts
         FROM artifacts a
         WHERE ${lower("a.created_at")} AND a.created_at < @to AND ${notIncognito("a.thread_id")}`,
      )
      .get(bind) as { created: number; charts: number };
    t.artifacts.created = created.created;
    t.artifacts.charts = created.charts;
    t.artifacts.versions = (
      sql
        .prepare(
          `SELECT COUNT(*) AS n FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
           WHERE ${lower("v.created_at")} AND v.created_at < @to AND ${notIncognito("a.thread_id")}`,
        )
        .get(bind) as { n: number }
    ).n;

    const jobs = sql
      .prepare(
        `SELECT json_extract(k.specialist, '$.result.outcome') AS outcome, COUNT(*) AS n
         FROM tasks k
         WHERE k.specialist IS NOT NULL
           AND json_extract(k.specialist, '$.result.outcome') IN ('done', 'partial', 'failed')
           AND ${lower("k.updated_at")} AND k.updated_at < @to AND ${notIncognito("k.thread_id")}
         GROUP BY 1`,
      )
      .all(bind) as { outcome: "done" | "partial" | "failed"; n: number }[];
    for (const r of jobs) t.specialists[r.outcome] = r.n;

    const top = sql
      .prepare(
        `SELECT au.id AS automationId, au.title AS title, COUNT(*) AS runs
         FROM runs r
         JOIN automation_runs ar ON ar.id = r.automation_run_id
         JOIN automations au ON au.id = ar.automation_id
         WHERE ${lower("r.started_at")} AND r.started_at < @to AND ${notIncognito("r.thread_id")}
         GROUP BY au.id
         ORDER BY runs DESC, au.title, au.id
         LIMIT 1`,
      )
      .get(bind) as { automationId: string; title: string; runs: number } | undefined;
    t.topAutomation = top ?? null;
    return t;
  }

  function firstActivityAt(): string | null {
    const row = sql
      .prepare(
        `SELECT MIN(at) AS at FROM (
           SELECT MIN(r.started_at) AS at FROM runs r WHERE ${notIncognito("r.thread_id")}
           UNION ALL SELECT MIN(a.requested_at) FROM approvals a WHERE ${notIncognito("a.thread_id")}
           UNION ALL SELECT MIN(f.created_at) FROM artifacts f WHERE ${notIncognito("f.thread_id")}
           UNION ALL SELECT MIN(k.created_at) FROM tasks k
             WHERE k.specialist IS NOT NULL AND ${notIncognito("k.thread_id")}
         )`,
      )
      .get() as { at: string | null };
    return row.at;
  }

  function topEntities(from: string | null, to: string): InsightEntity[] {
    return sql
      .prepare(
        `SELECT e.id AS entityId, e.kind AS kind, e.name AS name, COUNT(*) AS interactions,
                MAX(i.occurred_at) AS lastInteractionAt,
                (SELECT COUNT(*) FROM graph_loops l
                   WHERE l.counterpart_id = e.id AND l.status = 'open') AS openLoops
         FROM graph_participants p
         JOIN graph_interactions i ON i.id = p.interaction_id
         JOIN graph_entities e ON e.id = p.entity_id
         WHERE e.status = 'active' AND e.hidden = 0 AND e.is_owner = 0
           AND ${from === null ? "1 = 1" : "i.occurred_at >= @from"} AND i.occurred_at < @to
         GROUP BY e.id
         ORDER BY interactions DESC, lastInteractionAt DESC, e.name, e.id
         LIMIT ${MAX_ENTITIES}`,
      )
      .all(from === null ? { to } : { from, to }) as InsightEntity[];
  }

  return {
    "insights.summary": {
      run(_call: Call, params: MethodParams<"insights.summary">): MethodResult<"insights.summary"> {
        const timeZone = params.timeZone ?? "UTC";
        try {
          new Intl.DateTimeFormat("en-CA", { timeZone });
        } catch {
          throw new PsycheError("invalid_params", `unknown time zone ${timeZone}`);
        }
        const now = setup.now?.() ?? new Date();
        const to = now.toISOString();
        const today = dayIn(now, timeZone);
        const first = firstActivityAt();

        const spanDays = params.window === "all" ? ALL_DAYS : WINDOW_DAYS[params.window];
        const firstDay = shiftDay(today, -(spanDays - 1));
        const dayKeys = Array.from({ length: spanDays }, (_, i) => shiftDay(firstDay, i));
        const windowStart = startOfDay(firstDay, timeZone).toISOString();
        // `all` has no lower bound for totals; its days cover the last 53 weeks.
        const totalsFrom = params.window === "all" ? null : windowStart;

        const rows = runRows(totalsFrom, to);
        // For `all` the busiest day is over everything; the days list below keeps the last 53 weeks.
        const perDay = bucket(rows, timeZone);
        const totals = totalsFor(rows, perDay, totalsFrom, to);

        let previous: InsightTotals | null = null;
        if (params.window !== "all") {
          const prevStart = startOfDay(shiftDay(firstDay, -spanDays), timeZone).toISOString();
          const prevRows = runRows(prevStart, windowStart);
          previous = totalsFor(prevRows, bucket(prevRows, timeZone), prevStart, windowStart);
        }

        const days: InsightDay[] = dayKeys.map((date) => {
          const d = perDay.get(date);
          return {
            date,
            runs: { task: d?.task ?? 0, chat: d?.chat ?? 0, automation: d?.automation ?? 0 },
            failed: d?.failed ?? 0,
            wallMs: d?.wallMs ?? 0,
          };
        });

        return {
          window: params.window,
          range: { from: totalsFrom ?? first ?? windowStart, to },
          firstActivityAt: first,
          totals,
          previous,
          days,
          topEntities: topEntities(totalsFrom, to),
        };
      },
    },
  };
}
