import type { Run, ToolCall } from "@psyche/protocol";
import type { StepStatusKind } from "../components/status.tsx";
import type { RunStep } from "./RunStepLog.tsx";

/**
 * Where the agent is, as the step rail shows it. Built on the run steps the store already holds
 * (`runSteps`), never a second model: this file only decides how each step looks and which
 * earlier ones fold away.
 */

/** How a step reads on the rail. */
export type StepState =
  /** Finished well: settled, quiet. */
  | "done"
  /** The agent is on it now: the one moving indicator. */
  | "current"
  /** Paused on the owner (an approval or a question): unmistakable. */
  | "waiting"
  /** Failed or blocked: stays visible and red. */
  | "failed"
  /** Cancelled, paused or skipped: quiet, not a success. */
  | "stopped";

/** Finished steps kept in view before the older ones fold into "n earlier steps done". */
export const KEEP_DONE = 2;

export function stepState(step: Pick<RunStep, "status">): StepState {
  switch (step.status) {
    case "running":
      return "current";
    case "waiting":
      return "waiting";
    case "done":
      return "done";
    case "failed":
    case "blocked":
      return "failed";
    default:
      return "stopped";
  }
}

/**
 * The rail state of a run-trace row's status glyph kind, or null for the kinds the rail leaves to
 * the plain status glyph (retried, partial, skipped, paused, pending, cancelled).
 */
export function glyphState(status: StepStatusKind): StepState | null {
  switch (status) {
    case "running":
    case "thinking":
      return "current";
    case "waiting":
      return "waiting";
    case "done":
      return "done";
    case "failed":
    case "blocked":
      return "failed";
    default:
      return null;
  }
}

export type RailItem =
  | { kind: "step"; step: RunStep; state: StepState; isNow: boolean }
  | { kind: "earlier"; count: number };

/**
 * The rail's rows in order. Steps still running, waiting on the owner or failed are never folded;
 * finished ones beyond the last `KEEP_DONE` collapse into a single "earlier" row at the top of
 * the run (unless `expanded`). The "now" step is the latest one that is running or waiting.
 */
export function railItems(steps: readonly RunStep[], expanded = false): RailItem[] {
  const nowStep = [...steps]
    .reverse()
    .find((s) => stepState(s) === "current" || stepState(s) === "waiting");
  const doneIdx = steps.flatMap((s, i) => (stepState(s) === "done" ? [i] : []));
  const folded = new Set(expanded ? [] : doneIdx.slice(0, Math.max(0, doneIdx.length - KEEP_DONE)));
  const items: RailItem[] = [];
  if (folded.size > 0) items.push({ kind: "earlier", count: folded.size });
  steps.forEach((step, i) => {
    if (folded.has(i)) return;
    items.push({ kind: "step", step, state: stepState(step), isNow: step === nowStep });
  });
  return items;
}

/** Whether the run is paused on the owner right now (any step waiting). */
export function isWaitingOnYou(steps: readonly RunStep[]): boolean {
  return steps.some((s) => stepState(s) === "waiting");
}

/**
 * The plain-language label of the step each thread's run is on, for the compact views (sidebar,
 * thread rows): the latest running tool call of a running run, keyed by thread id.
 */
export function currentStepLabels(
  runs: Readonly<Record<string, Run>>,
  toolCalls: Readonly<Record<string, ToolCall>>,
): Record<string, string> {
  const latest: Record<string, ToolCall> = {};
  for (const call of Object.values(toolCalls)) {
    if (call.status !== "running") continue;
    const run = runs[call.runId];
    if (run === undefined || run.status !== "running") continue;
    const prev = latest[run.threadId];
    if (prev === undefined || call.startedAt > prev.startedAt) latest[run.threadId] = call;
  }
  const out: Record<string, string> = {};
  for (const [threadId, call] of Object.entries(latest))
    out[threadId] = call.target?.display ?? call.target?.value ?? call.tool;
  return out;
}
