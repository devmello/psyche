import type {
  Provenance,
  SearchIndexDoc,
  SearchIndexDocKind,
  SearchIndexHit,
} from "@psyche/protocol";

/**
 * Optional fields this package adds to `SearchIndexDoc`. They are proposed for the contract in a
 * `protocol:` PR; until it merges, callers pass them through this wider type.
 */
export interface SearchDoc extends SearchIndexDoc {
  /**
   * Who may see the document: `owner` (default) or the session key of a designated-person
   * thread (`telegram:peer:123`). A delegated viewer sees only its own scope.
   */
  scopeKey?: string;
  /** Hits collapse onto their parent in grouped results (a task action → its task). */
  parentId?: string;
  /** Producer id for bulk removal (a connector id, `library`, …). */
  source?: string;
}

/** The pane a result opens in; the Search screen groups by it (UI §3.13). */
export type SearchGroup =
  | "threads"
  | "tasks"
  | "memory"
  | "library"
  | "feed"
  | "ideas"
  | "goals"
  | "connectors"
  | "people"
  | "projects";

export const GROUP_OF_KIND: Record<SearchIndexDocKind, SearchGroup> = {
  thread: "threads",
  message: "threads",
  task: "tasks",
  memory: "memory",
  library: "library",
  feed: "feed",
  idea: "ideas",
  goal: "goals",
  connector: "connectors",
  person: "people",
  project: "projects",
};

/** People and Projects lead (docs/memory/people-and-projects-2026.md §6.4). */
export const GROUP_ORDER: SearchGroup[] = [
  "people",
  "projects",
  "threads",
  "tasks",
  "memory",
  "library",
  "feed",
  "ideas",
  "goals",
  "connectors",
];

/**
 * Who is searching. The owner sees every non-incognito document. A delegated viewer (the agent
 * answering a designated person, architecture §4.10) sees only documents of its own scope and
 * never memory.
 */
export type SearchViewer = { kind: "owner" } | { kind: "delegated"; scopeKey: string };

export const OWNER: SearchViewer = { kind: "owner" };
export const OWNER_SCOPE = "owner";

/** `[start, end)` offsets of matched text inside `snippet` or `title`. */
export type Range = [number, number];

import type { CardPreview } from "./cards/store.ts";

export interface RichHit extends SearchIndexHit {
  /** Summary of the item's context card and the source span it cites (when it has one). */
  card?: CardPreview;
  group: SearchGroup;
  /** Which retriever found it; set only when semantic search took part. */
  match?: "lexical" | "semantic" | "both";
  threadId?: string;
  parentId?: string;
  from?: string;
  mime?: string;
  /** Epoch ms. */
  createdAt: number;
  snippetHighlights: Range[];
  titleHighlights: Range[];
  /** Memory chunks: the workspace path (`memory/2026-10-16.md`). */
  sourcePath?: string;
}

export interface GroupResult {
  group: SearchGroup;
  /** Distinct results in the group (after collapsing messages onto threads). */
  count: number;
  hits: RichHit[];
}

export interface SearchRequest {
  q: string;
  viewer?: SearchViewer;
  /** Flat list size (default 20). */
  limit?: number;
  /** Hits per group (default 5). */
  groupLimit?: number;
  /** Restrict to these groups in addition to `in:` filters. */
  groups?: SearchGroup[];
  /** Restrict to these document kinds (intersected with `groups`). */
  kinds?: SearchIndexDocKind[];
  /** Collapse messages onto threads and actions onto tasks (default true). */
  collapse?: boolean;
}

export interface SearchResponse {
  /** Collapsed results across groups, best first. */
  hits: RichHit[];
  groups: GroupResult[];
  total: number;
  /** Filter tokens that were not understood. */
  warnings: string[];
  tookMs: number;
}

export type { Provenance };
