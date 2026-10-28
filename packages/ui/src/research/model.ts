/**
 * View state of a deep-research run, folded from the progress events the `research_run` tool
 * streams (`@psyche/research` `ProgressEvent`). The kit cannot import the engine, so the event
 * shapes are mirrored here structurally.
 */

export type ResearchStepId =
  | "scope"
  | "plan"
  | "read"
  | "extract"
  | "crosscheck"
  | "synthesize"
  | "save";

export type ResearchEvent =
  | { type: "step"; step: ResearchStepId }
  | {
      type: "plan";
      plan: {
        subQuestions: { id: string; question: string }[];
        includeLocal: boolean;
        estimatedTokens: number;
      };
    }
  | { type: "source"; url: string; title: string; status: "reading" | "read" | "failed" }
  | { type: "claims"; count: number }
  | { type: "tokens"; used: number; budget: number }
  | { type: "done"; artifactId: string }
  | { type: "stopped" };

export interface ResearchSourceView {
  url: string;
  title: string;
  status: "reading" | "read" | "failed";
}

export interface ResearchView {
  status: "running" | "done" | "stopped";
  step: ResearchStepId | null;
  questions: string[];
  includeLocal: boolean;
  estimatedTokens: number;
  tokens: number;
  claims: number;
  sources: ResearchSourceView[];
  artifactId: string | null;
}

export const emptyResearch: ResearchView = {
  status: "running",
  step: null,
  questions: [],
  includeLocal: false,
  estimatedTokens: 0,
  tokens: 0,
  claims: 0,
  sources: [],
  artifactId: null,
};

export function foldResearch(events: readonly ResearchEvent[]): ResearchView {
  let v: ResearchView = emptyResearch;
  for (const e of events) {
    switch (e.type) {
      case "step":
        v = { ...v, step: e.step };
        break;
      case "plan":
        v = {
          ...v,
          questions: e.plan.subQuestions.map((s) => s.question),
          includeLocal: e.plan.includeLocal,
          estimatedTokens: e.plan.estimatedTokens,
        };
        break;
      case "source": {
        const rest = v.sources.filter((s) => s.url !== e.url);
        const at = v.sources.findIndex((s) => s.url === e.url);
        const next = { url: e.url, title: e.title, status: e.status };
        const list =
          at === -1 ? [...rest, next] : v.sources.map((s) => (s.url === e.url ? next : s));
        v = { ...v, sources: list };
        break;
      }
      case "claims":
        v = { ...v, claims: e.count };
        break;
      case "tokens":
        v = { ...v, tokens: e.used };
        break;
      case "done":
        v = { ...v, status: "done", artifactId: e.artifactId };
        break;
      case "stopped":
        v = { ...v, status: "stopped" };
        break;
    }
  }
  return v;
}
