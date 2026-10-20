import type { SideEffect, Unsubscribe } from "@psyche/protocol";
import type { HookRegistry } from "./hooks.ts";

/**
 * Routine detection (feature T3): an in-process evaluator over the loop's `after_tool_call` and
 * `agent_end` hooks. It records which tools each owner turn used and, when the same sequence of
 * tool calls ends a turn successfully again in the same thread, reports the routine so the
 * Gateway can draft a skill from it. It never changes a call or a result, never sees runs
 * someone other than the owner asked for, unattended runs or subagents, and skips incognito
 * threads. Parameters are passed on for the draft generator, which keeps only their names.
 */

export interface RoutineStep {
  tool: string;
  sideEffect: SideEffect;
  params: unknown;
}

export interface RunTrace {
  threadId: string;
  runId: string;
  /** The owner's words that started the turn (raw: redact before showing anyone). */
  ownerText: string;
  /** The run read untrusted content. */
  taint: boolean;
  steps: RoutineStep[];
  /** Epoch ms when the turn ended. */
  at: number;
}

export interface RoutineObservation {
  threadId: string;
  /** Tool names in order, consecutive repeats collapsed. */
  tools: string[];
  /** `tools` joined; equal for every run of the routine. */
  signature: string;
  /** The runs with this routine in the thread, oldest first (at least `minOccurrences`). */
  runs: RunTrace[];
}

export interface RoutineDetectorOptions {
  onRoutine: (routine: RoutineObservation) => void | Promise<void>;
  /** Tool calls a routine needs (after ignored tools and collapsing). Default 3. */
  minSteps?: number;
  /** Runs of the same routine before it is reported. Default 2. */
  minOccurrences?: number;
  /** Turns remembered per thread. Default 20. */
  window?: number;
  /** Threads remembered. Default 200 (least recently used are forgotten). */
  maxThreads?: number;
  isIncognito?: (threadId: string) => boolean;
  /** Tools that never count (meta tools); default `DEFAULT_IGNORED_TOOL`. */
  ignoreTool?: (tool: string) => boolean;
  now?: () => number;
}

/** Meta tools: asking the owner, plans, checklists, skills themselves. */
export const DEFAULT_IGNORED_TOOL = (tool: string): boolean =>
  /^(ask_user|exit_plan_mode|ExitPlanMode|update_checklist|checklist|skills_search|skills_read|harness\.)/.test(
    tool,
  );

const MAX_PENDING_RUNS = 200;
const MAX_STEPS = 50;

/** Collapses consecutive calls of the same tool (`read, read, write` → `read, write`). */
export function routineTools(steps: readonly RoutineStep[]): string[] {
  const out: string[] = [];
  for (const s of steps) if (out[out.length - 1] !== s.tool) out.push(s.tool);
  return out;
}

export function attachRoutineDetector(
  hooks: HookRegistry,
  options: RoutineDetectorOptions,
): Unsubscribe {
  const minSteps = options.minSteps ?? 3;
  const minOccurrences = options.minOccurrences ?? 2;
  const window = options.window ?? 20;
  const maxThreads = options.maxThreads ?? 200;
  const ignore = options.ignoreTool ?? DEFAULT_IGNORED_TOOL;
  const now = options.now ?? Date.now;
  const pending = new Map<string, RoutineStep[]>();
  const history = new Map<string, RunTrace[]>();

  const offTool = hooks.on("after_tool_call", (ctx) => {
    if (ctx.result.isError === true || ignore(ctx.tool)) return undefined;
    let steps = pending.get(ctx.runId);
    if (steps === undefined) {
      if (pending.size >= MAX_PENDING_RUNS) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      steps = [];
      pending.set(ctx.runId, steps);
    }
    if (steps.length < MAX_STEPS)
      steps.push({ tool: ctx.tool, sideEffect: ctx.spec.sideEffect, params: ctx.params });
    return undefined;
  });

  const offEnd = hooks.on("agent_end", async (ctx) => {
    // A turn parked on an approval or a question resumes under the same run id.
    if (ctx.outcome === "awaiting_approval" || ctx.outcome === "awaiting_input") return;
    const steps = pending.get(ctx.runId) ?? [];
    pending.delete(ctx.runId);
    if (ctx.outcome !== "final") return;
    if (ctx.mode !== "attended" || ctx.subagent === true) return;
    const ownerText = ctx.ownerText ?? "";
    if (ownerText.trim() === "") return;
    if (options.isIncognito?.(ctx.threadId) === true) return;
    const tools = routineTools(steps);
    if (tools.length < minSteps) return;

    const trace: RunTrace = {
      threadId: ctx.threadId,
      runId: ctx.runId,
      ownerText,
      taint: ctx.taint === true,
      steps,
      at: now(),
    };
    const list = history.get(ctx.threadId) ?? [];
    history.delete(ctx.threadId);
    list.push(trace);
    while (list.length > window) list.shift();
    history.set(ctx.threadId, list);
    while (history.size > maxThreads) {
      const lru = history.keys().next().value;
      if (lru === undefined) break;
      history.delete(lru);
    }

    const signature = tools.join(">");
    const runs = list.filter((t) => routineTools(t.steps).join(">") === signature);
    if (runs.length < minOccurrences) return;
    try {
      await options.onRoutine({ threadId: ctx.threadId, tools, signature, runs });
    } catch {
      // Detection observes; a failing proposer changes nothing about the turn.
    }
  });

  return () => {
    offTool();
    offEnd();
    pending.clear();
    history.clear();
  };
}
