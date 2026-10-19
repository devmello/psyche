import type { Provenance } from "../common.ts";

/**
 * Unified search index contract (architecture §4.12; owner S16). One index across threads,
 * tasks, memory, library, feed, ideas, goals and opted-in connector caches. `index` upserts by
 * `id`. Incognito documents are never returned.
 */

export type SearchIndexDocKind =
  | "thread"
  | "message"
  | "task"
  | "memory"
  | "library"
  | "feed"
  | "idea"
  | "goal"
  | "connector";

export interface SearchIndexDoc {
  id: string;
  kind: SearchIndexDocKind;
  title: string;
  text: string;
  provenance: Provenance;
  threadId?: string;
  from?: string;
  mime?: string;
  tags?: string[];
  incognito?: boolean;
  /** Epoch ms. */
  createdAt: number;
  updatedAt?: number;
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

export interface SearchIndexFilters {
  kinds?: SearchIndexDocKind[];
  from?: string;
  threadId?: string;
  provenance?: Provenance[];
  /** Epoch ms bounds on `createdAt`. */
  before?: number;
  after?: number;
}

export interface SearchIndexQuery {
  q: string;
  filters?: SearchIndexFilters;
  limit?: number;
}

export interface SearchIndexHit {
  id: string;
  kind: SearchIndexDocKind;
  title: string;
  score: number;
  snippet: string;
  provenance: Provenance;
}

export interface SearchIndexResult {
  hits: SearchIndexHit[];
  total: number;
}

export interface SearchIndex {
  index(doc: SearchIndexDoc): Promise<void>;
  remove(id: string): Promise<void>;
  /** Hits sorted by descending score. */
  query(query: SearchIndexQuery): Promise<SearchIndexResult>;
}
