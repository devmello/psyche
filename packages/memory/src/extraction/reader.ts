import type { GraphCitationSource } from "@psyche/protocol";
import type Database from "better-sqlite3";

/**
 * Stage 1, the reader (docs/design/everything-memory-2026.md §5.1, §6.2). Reads new documents of
 * the search index by cursor: the ONE ingest path, so the index's own exclusions and deletions
 * apply. In this phase it returns the owner's own items only (provenance `owner`: sent mail, own
 * messages, own notes, #1006 trusted sources); other people's text is counted and skipped, never
 * returned, and never leaves the index. Opens the database read-only in spirit: it only SELECTs.
 */

export type ReadableSource = "mail" | "messages" | "notes" | "calendar" | "reminders" | "files";

/** `search_docs.source` tag per source (packages/search/src/sources/manager.ts `sourceTag`). */
export const SOURCE_TAGS: Record<ReadableSource, string> = {
  mail: "connector:mail",
  messages: "connector:imessage",
  notes: "connector:notes",
  calendar: "connector:calendar",
  reminders: "connector:reminders",
  files: "connector:files",
};

export const READABLE_SOURCES = Object.keys(SOURCE_TAGS) as ReadableSource[];

export function citationSource(source: ReadableSource): GraphCitationSource {
  return source;
}

export interface ReaderCursor {
  updatedMs: number;
  rowid: number;
}

export interface OwnerItem {
  /** `owner`: the owner's own words; `untrusted`: someone else's (EM5), only when asked for. */
  trust: "owner" | "untrusted";
  /** The sender as indexed (an address, number or name); only for `untrusted` items. */
  sender: string | null;
  source: ReadableSource;
  /** The search document id: the citation's `source_ref`. */
  docId: string;
  rowid: number;
  title: string;
  body: string;
  threadId: string | null;
  createdMs: number;
  updatedMs: number;
}

export interface ReadPage {
  items: OwnerItem[];
  /** Where to continue; absent when nothing was read. */
  next: ReaderCursor | undefined;
  /** Rows read that were not the owner's and were skipped. */
  skippedUntrusted: number;
  hasMore: boolean;
}

/** Anything that can page owner items; the search-backed reader is the production one. */
export interface ItemReader {
  read(
    source: ReadableSource,
    after: ReaderCursor,
    opts: { limit: number; windowDays: number; includeUntrusted?: boolean },
  ): ReadPage;
}

const DAY_MS = 86_400_000;

interface Row {
  rowid: number;
  id: string;
  title: string;
  body: string;
  provenance: string;
  scope_key: string;
  sender: string | null;
  thread_id: string | null;
  created_ms: number;
  updated_ms: number;
}

export class SearchDocReader implements ItemReader {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  read(
    source: ReadableSource,
    after: ReaderCursor,
    opts: { limit: number; windowDays: number; includeUntrusted?: boolean },
  ): ReadPage {
    const tag = SOURCE_TAGS[source];
    // Catch-up is bounded (§6.1): at most `windowDays` past the oldest unread item per run.
    const oldest = this.#db
      .prepare(
        `SELECT updated_ms FROM search_docs WHERE source = ? AND (updated_ms > ? OR (updated_ms = ? AND rowid > ?))
         ORDER BY updated_ms, rowid LIMIT 1`,
      )
      .get(tag, after.updatedMs, after.updatedMs, after.rowid) as
      | { updated_ms: number }
      | undefined;
    if (oldest === undefined)
      return { items: [], next: undefined, skippedUntrusted: 0, hasMore: false };
    const until = oldest.updated_ms + opts.windowDays * DAY_MS;
    const rows = this.#db
      .prepare(
        `SELECT rowid, id, title, body, provenance, scope_key, sender, thread_id, created_ms, updated_ms FROM search_docs
         WHERE source = ? AND (updated_ms > ? OR (updated_ms = ? AND rowid > ?)) AND updated_ms <= ?
         ORDER BY updated_ms, rowid LIMIT ?`,
      )
      .all(tag, after.updatedMs, after.updatedMs, after.rowid, until, opts.limit + 1) as Row[];
    const hasMore = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    const items: OwnerItem[] = [];
    let skipped = 0;
    for (const r of page) {
      // The owner's own scope only. Other people's text comes back only when asked for.
      const own = r.provenance === "owner";
      const theirs = r.provenance === "untrusted" && opts.includeUntrusted === true;
      if (r.scope_key !== "owner" || !(own || theirs)) {
        skipped++;
        continue;
      }
      items.push({
        trust: own ? "owner" : "untrusted",
        sender: own ? null : r.sender,
        source,
        docId: r.id,
        rowid: r.rowid,
        title: r.title,
        body: r.body,
        threadId: r.thread_id,
        createdMs: r.created_ms,
        updatedMs: r.updated_ms,
      });
    }
    return {
      items,
      next: last === undefined ? undefined : { updatedMs: last.updated_ms, rowid: last.rowid },
      skippedUntrusted: skipped,
      // More rows may remain beyond the window as well; the next run continues from the cursor.
      hasMore,
    };
  }
}
