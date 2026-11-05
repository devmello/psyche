import { getRun, getToolCall, type PsycheDb } from "@psyche/db";
import type { ResearchProgressEvent, WidgetBind } from "@psyche/protocol";
import type { Static } from "@sinclair/typebox";

/**
 * Live values behind `tool_call` and `research` widget bindings (generative-ui-2026 §5.4), for a
 * client that has no event store of its own (the phone). The desktop folds `research.progress`
 * events in memory; the Gateway does the same here, per tool call, bounded.
 */

export const RESEARCH_STEPS = [
  "scope",
  "plan",
  "read",
  "extract",
  "crosscheck",
  "synthesize",
  "save",
] as const;

interface Fold {
  step: number;
  claims: number;
  sources: Set<string>;
  state: "running" | "done" | "stopped";
}

export class ResearchTracker {
  readonly #folds = new Map<string, Fold>();
  readonly #cap: number;
  constructor(cap = 200) {
    this.#cap = cap;
  }

  apply(toolCallId: string, e: Static<typeof ResearchProgressEvent>): void {
    let f = this.#folds.get(toolCallId);
    if (f === undefined) {
      f = { step: 0, claims: 0, sources: new Set(), state: "running" };
      if (this.#folds.size >= this.#cap) {
        const oldest = this.#folds.keys().next().value;
        if (oldest !== undefined) this.#folds.delete(oldest);
      }
      this.#folds.set(toolCallId, f);
    }
    if (e.type === "step") f.step = RESEARCH_STEPS.indexOf(e.step) + 1;
    else if (e.type === "claims") f.claims = e.count;
    else if (e.type === "source") f.sources.add(e.url);
    else if (e.type === "done") f.state = "done";
    else if (e.type === "stopped") f.state = "stopped";
  }

  get(toolCallId: string): Fold | undefined {
    return this.#folds.get(toolCallId);
  }
}

export interface ResolvedBinding {
  available: boolean;
  status?: string;
  claims?: number;
  sources?: number;
  step?: number;
  steps?: number;
}

const RESEARCH_TOOLS = new Set(["research_run", "research_followup"]);

/** Resolves one binding of the widget's chat. Another chat's call and a missing one answer alike. */
export function resolveCallBinding(
  db: PsycheDb,
  tracker: ResearchTracker,
  bind: WidgetBind,
  threadId: string,
): ResolvedBinding {
  const call = getToolCall(db, bind.id);
  const run = call === undefined ? undefined : getRun(db, call.runId);
  if (call === undefined || run === undefined || run.threadId !== threadId) {
    return { available: false };
  }
  if (bind.source === "tool_call") return { available: true, status: call.status };
  if (bind.source !== "research" || !RESEARCH_TOOLS.has(call.tool)) return { available: false };
  const fold = tracker.get(call.id);
  const live = call.status === "running" || call.status === "pending";
  // As on the desktop: a "running" fold whose call already ended means the run stopped.
  let state = fold?.state ?? "running";
  if (state === "running" && !live) state = call.status === "ok" ? "done" : "stopped";
  const done = state === "done";
  return {
    available: true,
    status: state === "stopped" ? "cancelled" : state === "done" ? "done" : "running",
    claims: fold?.claims ?? 0,
    sources: fold?.sources.size ?? 0,
    step: done ? RESEARCH_STEPS.length : (fold?.step ?? 0),
    steps: RESEARCH_STEPS.length,
  };
}
