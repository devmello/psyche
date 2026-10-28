import { ResearchProgressEvent } from "@psyche/protocol";
import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** The tools whose `update.data` carries typed research progress. */
export const RESEARCH_TOOLS: ReadonlySet<string> = new Set(["research_run", "research_followup"]);

const cap = (s: unknown, n: number): unknown => (typeof s === "string" ? s.slice(0, n) : s);

/**
 * Shapes a research tool's `update.data` into a `research.progress` event, or null. Only the
 * known fields are kept (the engine's plan also carries the question) and the result must pass
 * the protocol schema, so arbitrary tool data never reaches the bus.
 */
export function toResearchProgress(data: unknown): Static<typeof ResearchProgressEvent> | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  let candidate: unknown = d;
  if (d.type === "plan" && typeof d.plan === "object" && d.plan !== null) {
    const p = d.plan as Record<string, unknown>;
    candidate = {
      type: "plan",
      plan: {
        subQuestions: Array.isArray(p.subQuestions)
          ? p.subQuestions.slice(0, 50).map((s: Record<string, unknown>) => ({
              id: cap(s?.id, 64),
              question: cap(s?.question, 500),
            }))
          : p.subQuestions,
        includeLocal: p.includeLocal,
        estimatedTokens: p.estimatedTokens,
      },
    };
  } else if (d.type === "source") {
    candidate = {
      type: "source",
      url: cap(d.url, 2000),
      title: cap(d.title, 500),
      status: d.status,
    };
  } else if (d.type === "step") candidate = { type: "step", step: d.step };
  else if (d.type === "claims") candidate = { type: "claims", count: d.count };
  else if (d.type === "tokens") candidate = { type: "tokens", used: d.used, budget: d.budget };
  else if (d.type === "done") candidate = { type: "done", artifactId: d.artifactId };
  else if (d.type === "stopped") candidate = { type: "stopped" };
  return Value.Check(ResearchProgressEvent, candidate)
    ? (candidate as Static<typeof ResearchProgressEvent>)
    : null;
}
