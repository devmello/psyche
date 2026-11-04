import { type AnswerPassage, excerptAround, passageSendable } from "@psyche/memory";
import {
  OWNER_ONLY_SOURCES,
  type SourceDocument,
  type SourceId,
  type SqliteSearchIndex,
  sourceTag,
} from "@psyche/search";

/**
 * The raw passages a life answer may read (docs/roadmap/future-features.md §1, phase 3): mail,
 * Messages, notes, calendar and files from the local index, found with the index's own ranking
 * (by meaning too when an embedder is configured). Nothing here calls a model.
 *
 * A passage is offered only when every one of these holds, so nothing that fails a rule is ever
 * sent to the model or shown in the answer or its chips:
 * - the owner has not kept its source from the agent (`agent` off, or flagged in the index): the
 *   same check as `search_everything`, so Messages, Contacts and Memory are out until allowed;
 * - the connection may open it with `search.document` (Messages are for the desktop app alone);
 * - its source's processing allows a cloud model, when the answering model is a cloud model;
 * - it holds no credential, id or account number, and no sensitive class that is off.
 */

/** Sources a raw answer reads. Contacts and Memory are covered by facts; Browser and chats are not people's words to quote. */
export const ANSWER_SOURCES: readonly SourceId[] = [
  "mail",
  "messages",
  "notes",
  "calendar",
  "files",
];

/** Who is asking: whether passages are offered at all, and whether this is the desktop app. */
export interface AnswerViewer {
  /** A paired client (a Mac helper is not): passages and chips open through `search.document`. */
  passages: boolean;
  /** The Psyche app on this Mac itself: may read the owner-only sources. */
  desktop: boolean;
}

export interface PassageSource {
  /** Passages for a question, best first, at most `limit`. */
  search(q: string, viewer: AnswerViewer, limit: number): Promise<AnswerPassage[]>;
  /** The passages with these ids, read again under the same rules (a follow-up's earlier citations). */
  byIds(ids: readonly string[], q: string, viewer: AnswerViewer): AnswerPassage[];
}

export interface PassageDeps {
  index: Pick<SqliteSearchIndex, "search">;
  /** A source passage as the agent may read it (`SourceIndexer.document(id, "agent")`). */
  document: (id: string) => SourceDocument | undefined;
  /** Producers whose text may not reach a cloud model (`SourceIndexer.cloudBlocked`). */
  cloudBlocked: () => readonly string[];
  /** Whether the model that answers is a cloud model. */
  cloud: () => boolean;
  /** The sensitive classes the owner switched on. */
  sensitive: () => Partial<Record<string, boolean>>;
  /** True when Memory's own opt-out keeps this source out (Settings → Memory). */
  optedOut?: (source: SourceId) => boolean;
}

export function lifePassages(deps: PassageDeps): PassageSource {
  const offer = (
    doc: SourceDocument | undefined,
    q: string,
    viewer: AnswerViewer,
  ): AnswerPassage | undefined => {
    if (doc === undefined || !viewer.passages) return undefined;
    if (!ANSWER_SOURCES.includes(doc.source)) return undefined;
    if (deps.optedOut?.(doc.source) === true) return undefined;
    if (!viewer.desktop && (OWNER_ONLY_SOURCES as readonly string[]).includes(doc.source))
      return undefined;
    if (deps.cloud() && deps.cloudBlocked().includes(sourceTag(doc.source))) return undefined;
    const text = excerptAround(doc.text, q);
    const title = doc.title.slice(0, 200);
    if (text === "" || !passageSendable(title, text, deps.sensitive())) return undefined;
    return { id: doc.id, source: doc.source, title, text, createdAt: doc.createdAt };
  };
  return {
    async search(q, viewer, limit) {
      if (!viewer.passages || q.trim() === "") return [];
      let hits: { id: string }[];
      try {
        hits = (
          await deps.index.search({
            q,
            viewer: { kind: "owner" },
            audience: "agent",
            sources: ANSWER_SOURCES.map(sourceTag),
            limit: limit * 3,
            collapse: false,
          })
        ).hits;
      } catch {
        return [];
      }
      const out: AnswerPassage[] = [];
      for (const h of hits) {
        const p = offer(deps.document(h.id), q, viewer);
        if (p !== undefined && !out.some((o) => o.id === p.id)) out.push(p);
        if (out.length >= limit) break;
      }
      return out;
    },
    byIds(ids, q, viewer) {
      const out: AnswerPassage[] = [];
      for (const id of new Set(ids)) {
        const p = offer(deps.document(id), q, viewer);
        if (p !== undefined) out.push(p);
      }
      return out;
    },
  };
}
