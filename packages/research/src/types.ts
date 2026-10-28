/**
 * Deep research (docs: a multi-step run that ends in a cited report). The engine is a pure
 * pipeline over a `ResearchHost`: it never holds a tool, so nothing it reads can trigger a write.
 * Everything fetched is untrusted data; it only ever reaches a model inside a delimited data
 * block, and the model's reply is parsed as JSON claims, never executed.
 */

export type ModelTier = "cheap" | "thread";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface PageText {
  title?: string;
  text: string;
}

export interface Completion {
  text: string;
  tokens: number;
}

export interface ResearchHost {
  search(query: string, o: { count: number; signal: AbortSignal }): Promise<SearchResult[]>;
  fetch(url: string, o: { signal: AbortSignal }): Promise<PageText>;
  /** The hybrid search index (files, mail, notes). Only called when the owner opted in. */
  localSearch?(query: string, o: { signal: AbortSignal }): Promise<LocalHit[]>;
  /** `cheap` for extraction and cross-checking, `thread` for planning and synthesis. */
  complete(
    tier: ModelTier,
    system: string,
    user: string,
    o: { signal: AbortSignal },
  ): Promise<Completion>;
}

export interface LocalHit {
  title: string;
  /** A stable reference, e.g. `psyche://mail/123`. */
  url: string;
  text: string;
}

export interface SubQuestion {
  id: string;
  question: string;
  queries: string[];
}

export interface ResearchPlan {
  question: string;
  subQuestions: SubQuestion[];
  includeLocal: boolean;
  estimatedTokens: number;
}

export interface Budget {
  /** Most sources read in one run. */
  maxSources: number;
  /** Most tokens the run may spend; reading stops when it is reached. */
  maxTokens: number;
  /** Subagent-style parallelism for reads. */
  concurrency: number;
  /** Results taken per query. */
  perQuery: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxSources: 12,
  maxTokens: 120_000,
  concurrency: 3,
  perQuery: 4,
};

export interface Source {
  /** Citation number in the report, assigned in order of first use. */
  n: number;
  url: string;
  title: string;
  kind: "web" | "local";
  subQuestionId: string;
}

export interface Claim {
  id: string;
  sourceUrl: string;
  subQuestionId: string;
  text: string;
  /** Verbatim from the page (verified; claims whose quote is not on the page are dropped). */
  quote: string;
  /** Other sources that say the same thing. */
  corroboratedBy: string[];
  /** Set by the cross-check when sources disagree. */
  conflict?: string;
}

export interface ReportSection {
  heading: string;
  body: string;
}

export type ProgressEvent =
  | { type: "step"; step: ResearchStep }
  | { type: "plan"; plan: ResearchPlan }
  | { type: "source"; url: string; title: string; status: "reading" | "read" | "failed" }
  | { type: "claims"; count: number }
  | { type: "tokens"; used: number; budget: number }
  | { type: "done"; artifactId: string }
  | { type: "stopped" };

export type ResearchStep =
  | "scope"
  | "plan"
  | "read"
  | "extract"
  | "crosscheck"
  | "synthesize"
  | "save";

export interface ResearchReport {
  title: string;
  summary: string;
  sections: ReportSection[];
  openQuestions: string[];
  sources: Source[];
  markdown: string;
}

export interface SavedArtifact {
  id: string;
}

export interface ArtifactSink {
  /** The report is saved as untrusted provenance (security §3.6). */
  create(title: string, markdown: string): Promise<SavedArtifact>;
  update(id: string, markdown: string): Promise<void>;
}

export class ResearchStopped extends Error {
  constructor() {
    super("research stopped");
    this.name = "ResearchStopped";
  }
}
