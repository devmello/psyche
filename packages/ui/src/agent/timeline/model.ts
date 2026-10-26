import type { Run, RunStep, RunStepStatus, Usage } from "@psyche/protocol";
import { type Gap, type Interval, idleGaps } from "../../components/timeline/scale.ts";
import type { BarKind, BarSegment } from "../../components/timeline/Timeline.tsx";

/**
 * The Timeline's row model (docs/design/run-trace-2026.md §3.3), pure so the waterfall, the List
 * view, the keyboard map and replay all read one shape:
 * - steps dispatched together (`groupId`) sit under a "{n} at once" group row;
 * - a helper's steps (its child run) nest one level under its `subagent` step;
 * - groups and helpers roll up their children's tokens and cost ("—" when none is known);
 * - idle gaps over 10 s that nobody is working through collapse into a break.
 */

export const IDLE_GAP_MS = 10_000;

export interface Rollup {
  /** Total tokens, or null when no step under this row reported usage. */
  tokens: number | null;
  costUsd: number | null;
}

export interface TraceRow {
  /** The step id, or the group id for a group row. */
  id: string;
  type: "step" | "group";
  /** The run the step belongs to (a helper's steps carry the helper's run id). */
  runId: string;
  step: RunStep | null;
  level: number;
  /** The tense-correct label: `doneLabel` once ended. */
  label: string;
  status: RunStepStatus;
  start: number;
  /** Null while running. */
  end: number | null;
  barKind: BarKind;
  segments?: BarSegment[];
  /** Earlier attempts of a retried step (faint segments before the current one). */
  attempts: { start: number; end: number | null; failed: boolean }[];
  rollup: Rollup;
  children: TraceRow[];
  /** A group or helper row that can fold. */
  foldable: boolean;
}

export interface VisibleRow extends TraceRow {
  expanded: boolean;
  /** The row's position among its siblings, for `aria-posinset` / `aria-setsize`. */
  posInSet: number;
  setSize: number;
}

export function ms(iso: string | null | undefined): number | null {
  if (iso == null) return null;
  const n = Date.parse(iso);
  return Number.isNaN(n) ? null : n;
}

export function stepLabel(step: RunStep): string {
  const ended = step.endedAt !== null && step.status !== "running" && step.status !== "waiting";
  return ended && step.doneLabel ? step.doneLabel : step.label;
}

export function barKindOf(step: RunStep): BarKind {
  if (step.status === "failed") return "failed";
  if (step.kind === "approval" || step.kind === "question" || step.status === "waiting")
    return "waiting";
  if (step.kind === "subagent") return "helper";
  if (step.kind === "thinking" || step.kind === "model") return "thinking";
  return "tool";
}

/** Steps whose time is someone waiting (on you): hatched, and not "work" for idle gaps. */
export function isWait(step: RunStep): boolean {
  return step.kind === "approval" || step.kind === "question" || step.status === "waiting";
}

export function usageTokens(u: Usage | undefined | null): number | null {
  if (!u) return null;
  return u.input + u.output + u.cacheRead + u.cacheWrite + u.reasoning;
}

function addRollup(a: Rollup, b: Rollup): Rollup {
  return {
    tokens: a.tokens === null ? b.tokens : b.tokens === null ? a.tokens : a.tokens + b.tokens,
    costUsd:
      a.costUsd === null ? b.costUsd : b.costUsd === null ? a.costUsd : a.costUsd + b.costUsd,
  };
}

const NO_ROLLUP: Rollup = { tokens: null, costUsd: null };

function stepRow(
  step: RunStep,
  level: number,
  childSteps: Readonly<Record<string, readonly RunStep[]>>,
  runs: Readonly<Record<string, Run>>,
): TraceRow {
  const start = ms(step.startedAt) ?? 0;
  const end = step.status === "running" || step.status === "waiting" ? null : ms(step.endedAt);
  const helperSteps = step.childRunId ? (childSteps[step.childRunId] ?? []) : [];
  const children =
    step.kind === "subagent" && helperSteps.length > 0
      ? buildRows(helperSteps, childSteps, runs, level + 1)
      : [];
  const own: Rollup = step.usage
    ? { tokens: usageTokens(step.usage), costUsd: step.usage.costUsd ?? null }
    : NO_ROLLUP;
  const childRun = step.childRunId ? runs[step.childRunId] : undefined;
  const rollup =
    children.length > 0
      ? childRun
        ? { tokens: usageTokens(childRun.usage), costUsd: childRun.usage.costUsd ?? null }
        : children.reduce((r, c) => addRollup(r, c.rollup), NO_ROLLUP)
      : own;
  const row: TraceRow = {
    id: step.id,
    type: "step",
    runId: step.runId,
    step,
    level,
    label: stepLabel(step),
    status: step.status,
    start,
    end,
    barKind: barKindOf(step),
    attempts: (step.attempts ?? []).map((a) => ({
      start: ms(a.startedAt) ?? start,
      end: ms(a.endedAt),
      failed: a.status === "failed",
    })),
    rollup,
    children,
    foldable: children.length > 0,
  };
  if (isWait(step)) row.segments = [{ kind: "wait", from: start, to: end ?? undefined }];
  return row;
}

/** Rows for one run's steps (in seq order), grouping parallel steps and nesting helpers. */
export function buildRows(
  steps: readonly RunStep[],
  childSteps: Readonly<Record<string, readonly RunStep[]>> = {},
  runs: Readonly<Record<string, Run>> = {},
  level = 0,
): TraceRow[] {
  const sorted = [...steps].sort((a, b) => a.seq - b.seq);
  const rows: TraceRow[] = [];
  let i = 0;
  while (i < sorted.length) {
    const s = sorted[i] as RunStep;
    if (s.groupId !== undefined) {
      const members: RunStep[] = [];
      while (i < sorted.length && (sorted[i] as RunStep).groupId === s.groupId) {
        members.push(sorted[i] as RunStep);
        i += 1;
      }
      if (members.length > 1) {
        const children = members.map((m) => stepRow(m, level + 1, childSteps, runs));
        const ends = children.map((c) => c.end);
        const anyFailed = children.some((c) => c.status === "failed");
        const anyRunning = ends.some((e) => e === null);
        rows.push({
          id: s.groupId,
          type: "group",
          runId: s.runId,
          step: null,
          level,
          label: "",
          status: anyFailed ? "failed" : anyRunning ? "running" : "ok",
          start: Math.min(...children.map((c) => c.start)),
          end: anyRunning ? null : Math.max(...(ends as number[])),
          barKind: anyFailed ? "failed" : "tool",
          attempts: [],
          rollup: children.reduce((r, c) => addRollup(r, c.rollup), NO_ROLLUP),
          children,
          foldable: true,
        });
        continue;
      }
      rows.push(stepRow(members[0] as RunStep, level, childSteps, runs));
      continue;
    }
    rows.push(stepRow(s, level, childSteps, runs));
    i += 1;
  }
  return rows;
}

/** Helpers fold once they're done; groups and running helpers stay open (§3.2, §3.3). */
export function defaultFolded(rows: readonly TraceRow[]): Set<string> {
  const out = new Set<string>();
  const walk = (rs: readonly TraceRow[]) => {
    for (const r of rs) {
      if (r.type === "step" && r.foldable && r.end !== null && r.status !== "failed") out.add(r.id);
      walk(r.children);
    }
  };
  walk(rows);
  return out;
}

/** The rows a tree shows with `folded` collapsed, in display order. */
export function visibleRows(rows: readonly TraceRow[], folded: ReadonlySet<string>): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (rs: readonly TraceRow[]) => {
    rs.forEach((r, idx) => {
      const expanded = r.foldable && !folded.has(r.id);
      out.push({ ...r, expanded, posInSet: idx + 1, setSize: rs.length });
      if (expanded) walk(r.children);
    });
  };
  walk(rows);
  return out;
}

/** Every row in the tree, folded ones included (the List view and search). */
export function allRows(rows: readonly TraceRow[]): TraceRow[] {
  const out: TraceRow[] = [];
  const walk = (rs: readonly TraceRow[]) => {
    for (const r of rs) {
      out.push(r);
      walk(r.children);
    }
  };
  walk(rows);
  return out;
}

/** The id path from the root to `id` (so selecting a folded step can unfold its parents). */
export function ancestorsOf(rows: readonly TraceRow[], id: string): string[] {
  const path: string[] = [];
  const walk = (rs: readonly TraceRow[]): boolean => {
    for (const r of rs) {
      if (r.id === id) return true;
      path.push(r.id);
      if (walk(r.children)) return true;
      path.pop();
    }
    return false;
  };
  return walk(rows) ? path : [];
}

/** The step a failed run opens on: the last failed step, nested ones included. */
export function failedStep(rows: readonly TraceRow[]): TraceRow | null {
  const failed = allRows(rows).filter((r) => r.type === "step" && r.status === "failed");
  return failed.at(-1) ?? null;
}

/** Steps `[` / `]` jump between: failed or retried. */
export function issueRows(rows: readonly TraceRow[]): TraceRow[] {
  return allRows(rows).filter(
    (r) => r.type === "step" && (r.status === "failed" || (r.step?.attempt ?? 1) > 1),
  );
}

/** Idle spans over 10 s where nothing worked (waits on you count as idle), for the breaks. */
export function traceGaps(rows: readonly TraceRow[], end: number): Gap[] {
  const work: Interval[] = allRows(rows)
    .filter((r) => r.type === "step" && r.step !== null && !isWait(r.step))
    .flatMap((r) => [
      { start: r.start, end: r.end ?? undefined },
      ...r.attempts.map((a) => ({ start: a.start, end: a.end ?? undefined })),
    ]);
  if (work.length === 0) return [];
  return idleGaps(work, end, IDLE_GAP_MS);
}

/** Whether a row overlaps the time range (Instruments' inspection range, §3.5). */
export function inRange(row: TraceRow, range: { from: number; to: number } | null, now: number) {
  if (range === null) return true;
  return row.start <= range.to && (row.end ?? now) >= range.from;
}

/** The List view's search: label, target, previews, thinking summary and error text. */
export function matchesQuery(row: TraceRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const s = row.step;
  const hay = [
    row.label,
    s?.label,
    s?.target,
    s?.preview?.input,
    s?.preview?.output,
    s?.text?.summary,
    s?.error?.message,
    s?.progress?.message,
  ];
  return hay.some((h) => h?.toLowerCase().includes(q) ?? false);
}

/** Range totals: steps, tokens and cost of the steps in range ("—" when unknown). */
export function totalsFor(rows: readonly TraceRow[]): Rollup & { steps: number } {
  const steps = rows.filter((r) => r.type === "step");
  return {
    steps: steps.length,
    ...steps
      .filter((r) => !r.foldable)
      .reduce((acc, r) => addRollup(acc, r.rollup), NO_ROLLUP as Rollup),
  };
}
