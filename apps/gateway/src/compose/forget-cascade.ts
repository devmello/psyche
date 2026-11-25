import type { PsycheDb } from "@psyche/db";
import {
  applyGraphForget,
  applyGraphReset,
  applyLessonForget,
  type ForgetCascade,
  type ForgetCounts,
  type GraphResetCounts,
  type GraphStore,
  mentions,
  previewGraphForget,
  previewGraphReset,
  previewLessonForget,
  type SqliteMemoryStore,
  type TeachingService,
  type TeachingStore,
} from "@psyche/memory";
import { PsycheError } from "@psyche/protocol";
import { SqliteSearchIndex } from "@psyche/search";

/**
 * Forget everywhere (memory wave 3A): the stores `SqliteMemoryStore.forget` does not own. Each
 * part counts and deletes from the same selection, so a preview's numbers are the forget's.
 *
 * - The people graph and the extraction tables (`@psyche/memory` `graph/forget.ts`), then the
 *   card files of the entities that were deleted.
 * - Lessons, their feedback and their lines in AGENTS.md and a skill's LESSONS.md.
 * - Memory documents in the search indexes: the graph's People and Projects documents sit in
 *   `psyche.sqlite`, Memory's source items and the daily notes' cards in `search.sqlite`.
 *
 * Run traces and saved chats are cut by `onForget` in the background and are not counted.
 */
export interface ForgetCascadeDeps {
  memory: SqliteMemoryStore;
  /** The database the people graph lives in (`psyche.sqlite`, or the encrypted memory file). */
  graphSqlite: () => PsycheDb["sqlite"];
  /** The main database, where the graph's own search documents are kept. */
  db: PsycheDb;
  graph: () => GraphStore | undefined;
  cards: () => { remove(path: string): Promise<unknown> } | undefined;
  teaching: () => { store: TeachingStore; service: Pick<TeachingService, "forget"> } | undefined;
  /** The Search index (`search.sqlite`); absent while its encrypted key is pending. */
  searchIndex: () => Pick<SqliteSearchIndex, "purgeMemoryDocs"> | undefined;
}

export function composeForgetCascade(deps: ForgetCascadeDeps) {
  const graphDocs = new SqliteSearchIndex(deps.db.sqlite);
  const searchDocs = (m: Parameters<ForgetCascade["preview"]>[0], dryRun: boolean): number => {
    const matches = (text: string) => mentions(m, text);
    let n = graphDocs.purgeMemoryDocs(matches, { dryRun });
    n += deps.searchIndex()?.purgeMemoryDocs(matches, { dryRun }) ?? 0;
    return n;
  };
  const lessonDeps = () => {
    const t = deps.teaching();
    return t === undefined ? undefined : { ...t, memory: deps.memory };
  };

  const cascade: ForgetCascade = {
    async preview(m) {
      const out: Partial<ForgetCounts> = {};
      const graph = deps.graph();
      if (graph !== undefined)
        Object.assign(out, previewGraphForget(deps.graphSqlite(), graph, m).counts);
      const lessons = lessonDeps();
      if (lessons !== undefined) Object.assign(out, await previewLessonForget(lessons, m));
      out.searchDocs = searchDocs(m, true);
      return out;
    },

    async apply(m) {
      const out: Partial<ForgetCounts> = {};
      // Counted before the graph goes: deleting an entity drops its own search document at once.
      const docs = searchDocs(m, true);
      const graph = deps.graph();
      if (graph !== undefined) {
        const r = applyGraphForget(deps.graphSqlite(), graph, m);
        Object.assign(out, r.counts);
        // The deleted people's card files; the lines `forget` already cut left a husk.
        const cards = deps.cards();
        for (const path of r.cardPaths) await cards?.remove(path).catch(() => undefined);
      }
      const lessons = lessonDeps();
      if (lessons !== undefined) Object.assign(out, await applyLessonForget(lessons, m));
      // Last: the graph is already empty of it, so nothing re-indexes the phrase.
      searchDocs(m, false);
      out.searchDocs = docs;
      return out;
    },
  };
  return cascade;
}

/** `memory.reset` beyond the workspace: the graph, extraction tables and their search rows. */
export function composeGraphReset(deps: ForgetCascadeDeps) {
  const graphDocs = new SqliteSearchIndex(deps.db.sqlite);
  return {
    preview(): GraphResetCounts {
      return previewGraphReset(deps.graphSqlite());
    },
    async apply(): Promise<GraphResetCounts> {
      const graph = deps.graph();
      if (graph === undefined)
        throw new PsycheError("unavailable", "the memory graph is not ready");
      const counts = applyGraphReset(deps.graphSqlite(), graph);
      graphDocs.purgeMemoryDocs(() => true, { dryRun: false });
      deps.searchIndex()?.purgeMemoryDocs(() => true, { dryRun: false });
      return counts;
    },
  };
}
