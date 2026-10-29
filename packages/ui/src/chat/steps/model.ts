import type { Receipt, Run, RunStep } from "@psyche/protocol";
import { type StepStatusKind, stepStatusKind } from "../../components/status.tsx";
import { formatStepDuration } from "../../components/steps/LiveDuration.tsx";
import { t } from "../../i18n/core.ts";
import type { MessageId } from "../../i18n/messages/index.ts";

/**
 * The chat's steps (docs/design/run-trace-2026.md §3.2, T2) as rows, from a run's `RunStep`s.
 * Pure: the step list, the summary row and their tests all read these.
 */

/** Steps that stay visible while the rest fold into "Show all" (§3.2). */
export const VISIBLE_STEPS = 5;
/** Parallel rows shown under "{n} at once" before "+{n} more". */
export const GROUP_ROWS = 3;
/** Silence after which the active row says "No response for …" (§3.2). */
export const STALL_MS = 30_000;

const ENDED: readonly RunStep["status"][] = ["ok", "failed", "cancelled", "skipped", "denied"];

export const ended = (step: RunStep): boolean => ENDED.includes(step.status);

/** The status line in the right tense: "Searching flights" → "Searched flights" once it ends. */
export function stepLabel(step: RunStep): string {
  if (step.kind === "thinking") {
    const summary = step.text?.summary?.trim();
    return summary ? t("chat.steps.thinking", { text: summary }) : t("chat.steps.thinkingEmpty");
  }
  return ended(step) ? (step.doneLabel ?? step.label) : step.label;
}

/** The glyph: a running thought shows the thinking glyph, everything else its status. */
export function stepGlyph(step: RunStep): StepStatusKind {
  if (step.kind === "thinking" && step.status === "running") return "thinking";
  return stepStatusKind(step.status);
}

export type TraceRow =
  | { type: "step"; key: string; step: RunStep }
  /** Consecutive steps with the same tool and outcome, shown as one row ("×4"). */
  | { type: "repeat"; key: string; steps: readonly RunStep[] }
  /** Steps dispatched together ("{n} at once"). */
  | { type: "group"; key: string; steps: readonly RunStep[] };

const firstWord = (s: string): string => s.split(/\s+/, 1)[0]?.toLowerCase() ?? "";

/** Same tool and outcome: a finished tool step with the same verb, target and status. */
function sameRepeat(a: RunStep, b: RunStep): boolean {
  return (
    a.kind === "tool" &&
    b.kind === "tool" &&
    a.groupId === undefined &&
    b.groupId === undefined &&
    ended(a) &&
    ended(b) &&
    a.status === b.status &&
    a.status !== "failed" &&
    (a.target ?? "") === (b.target ?? "") &&
    firstWord(stepLabel(a)) === firstWord(stepLabel(b))
  );
}

/**
 * Rows in run order: a parallel group becomes one group row; consecutive repeats fold into one
 * row; helper steps (on their own runs) are not here, the helper's spawn step carries them.
 * Failed steps are never folded into a repeat.
 */
export function buildRows(steps: readonly RunStep[]): TraceRow[] {
  const rows: TraceRow[] = [];
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i] as RunStep;
    if (s.groupId !== undefined) {
      const group: RunStep[] = [s];
      while (ordered[i + 1]?.groupId === s.groupId) group.push(ordered[++i] as RunStep);
      rows.push(
        group.length === 1
          ? { type: "step", key: s.id, step: s }
          : { type: "group", key: s.groupId, steps: group },
      );
      continue;
    }
    const repeat: RunStep[] = [s];
    while (ordered[i + 1] !== undefined && sameRepeat(s, ordered[i + 1] as RunStep))
      repeat.push(ordered[++i] as RunStep);
    rows.push(
      repeat.length === 1
        ? { type: "step", key: s.id, step: s }
        : { type: "repeat", key: s.id, steps: repeat },
    );
  }
  return rows;
}

const rowSteps = (row: TraceRow): readonly RunStep[] =>
  row.type === "step" ? [row.step] : row.steps;

/** A row that must stay visible: something failed in it, or it waits on the owner. */
const pinned = (row: TraceRow): boolean =>
  rowSteps(row).some((s) => s.status === "failed" || s.status === "waiting");

/** The rows to show: the last five, plus any failed or waiting row (they never fold away). */
export function visibleRows(rows: readonly TraceRow[], all: boolean): TraceRow[] {
  if (all) return [...rows];
  return rows.filter((row, i) => i >= rows.length - VISIBLE_STEPS || pinned(row));
}

/** The step everything else waits on: the latest that is running or waiting. */
export function activeStep(steps: readonly RunStep[]): RunStep | null {
  let found: RunStep | null = null;
  for (const s of steps) {
    if (s.status !== "running" && s.status !== "waiting") continue;
    if (found === null || s.seq > found.seq) found = s;
  }
  return found;
}

/** Epoch ms of the run's last event: a step started or ended, or the run's own last step time. */
export function lastEventAt(
  run: Pick<Run, "startedAt" | "lastStepAt">,
  steps: readonly RunStep[],
): number {
  let last = Date.parse(run.startedAt);
  if (run.lastStepAt) last = Math.max(last, Date.parse(run.lastStepAt));
  for (const s of steps) {
    last = Math.max(last, Date.parse(s.startedAt));
    if (s.endedAt) last = Math.max(last, Date.parse(s.endedAt));
  }
  return last;
}

/** Side effects by receipt kind, first in the summary (§3.2): what was sent, added or changed. */
const EFFECT_KEYS: Record<string, MessageId> = {
  send_email: "chat.steps.effect.sentEmails",
  calendar_write: "chat.steps.effect.addedEvents",
  file_write: "chat.steps.effect.wroteFiles",
  purchase: "chat.steps.effect.purchases",
  browser_submit: "chat.steps.effect.submittedForms",
};

/** Receipt kinds that only read: counted as work, never listed as a side effect. */
const READ_KINDS = new Set(["browser_read", "read", "search", "fetch"]);

export interface RunSummary {
  tone: "done" | "failed" | "cancelled" | "incognito";
  text: string;
}

/**
 * The one line a finished run condenses into (§3.2): "Worked for 1 min 12 s · sent 1 email ·
 * added 1 event · 9 steps", or the failed / cancelled / incognito form.
 */
export function summarizeRun(
  run: Pick<Run, "status" | "startedAt" | "endedAt">,
  steps: readonly RunStep[],
  receipts: readonly Pick<Receipt, "kind" | "outcome">[],
  options: { incognito?: boolean } = {},
): RunSummary {
  const ms =
    (run.endedAt ? Date.parse(run.endedAt) : Date.parse(steps.at(-1)?.endedAt ?? run.startedAt)) -
    Date.parse(run.startedAt);
  const duration = formatStepDuration(Math.max(0, ms));
  const count = steps.length;
  if (options.incognito) return { tone: "incognito", text: t("chat.steps.summary.incognito") };
  if (run.status === "failed") {
    const ordered = [...steps].sort((a, b) => a.seq - b.seq);
    const index = ordered.findIndex((s) => s.status === "failed");
    const failed = ordered[index];
    return {
      tone: "failed",
      text: failed
        ? t("chat.steps.summary.failedAt", {
            n: index + 1,
            label: failed.label,
            duration,
          })
        : t("chat.steps.summary.failed", { duration }),
    };
  }
  if (run.status === "cancelled")
    return { tone: "cancelled", text: t("chat.steps.summary.cancelled", { duration, n: count }) };
  const parts = [t("chat.steps.summary.worked", { duration })];
  const effects = new Map<MessageId, number>();
  for (const r of receipts) {
    if (r.outcome === "failed" || READ_KINDS.has(r.kind)) continue;
    const key: MessageId = EFFECT_KEYS[r.kind] ?? "chat.steps.effect.changes";
    effects.set(key, (effects.get(key) ?? 0) + 1);
  }
  for (const [key, n] of effects) parts.push(t(key, { n }));
  parts.push(t("chat.steps.summary.steps", { n: count }));
  return { tone: "done", text: parts.join(" · ") };
}

/** Where "Timeline ›" goes: T3's Timeline on this run (#737), optionally landing on a step. */
export function timelineRoute(runId: string, stepId?: string): string {
  const base = `/agent/activity/run/${encodeURIComponent(runId)}`;
  return stepId === undefined ? base : `${base}?step=${encodeURIComponent(stepId)}`;
}
