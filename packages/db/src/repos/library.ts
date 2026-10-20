import type { LibraryItem } from "@psyche/protocol";
import { and, desc, eq, sql } from "drizzle-orm";
import { libraryItemFromRow } from "../mappers.ts";
import type { PsycheDb } from "../open.ts";
import { libraryItems } from "../schema.ts";

/** What a Library writer records for a file it saved (data model §9). */
export interface NewLibraryItem {
  /** Default `db.newId()`; writers that name files by id pass theirs. */
  id?: string;
  kind: LibraryItem["kind"];
  name: string;
  mime: string;
  /** Relative to `$PSYCHE_HOME/library`. */
  path: string;
  size: number;
  sha256: string;
  origin: LibraryItem["origin"];
  threadId?: string | null;
  taskId?: string | null;
  tags?: readonly string[];
  textExtractRef?: string | null;
  quarantined?: boolean;
  /** Writer's provenance detail (channel message, download URL); stored, never returned. */
  source?: Record<string, unknown> | null;
  /** Default `db.now()`. */
  createdAt?: string;
}

export interface LibraryPageOptions {
  kind?: LibraryItem["kind"];
  threadId?: string;
  taskId?: string;
  /** Case-insensitive substring of the name. */
  query?: string;
  offset?: number;
  limit?: number;
}

export function insertLibraryItem(db: PsycheDb, input: NewLibraryItem): LibraryItem {
  const row = db.drizzle
    .insert(libraryItems)
    .values({
      id: input.id ?? db.newId(),
      kind: input.kind,
      name: input.name,
      mime: input.mime,
      path: input.path,
      size: input.size,
      sha256: input.sha256,
      origin: input.origin,
      threadId: input.threadId ?? null,
      taskId: input.taskId ?? null,
      tags: JSON.stringify(input.tags ?? []),
      textExtractRef: input.textExtractRef ?? null,
      quarantined: input.quarantined === true ? 1 : 0,
      source: input.source == null ? null : JSON.stringify(input.source),
      createdAt: input.createdAt ?? db.now(),
    })
    .returning()
    .get();
  return libraryItemFromRow(row);
}

/**
 * Inserts the item, or refreshes size and hash of the row already at `path` (a recording that
 * was imported again) and returns that row with its original id.
 */
export function upsertLibraryItemByPath(db: PsycheDb, input: NewLibraryItem): LibraryItem {
  return db.sqlite.transaction(() => {
    const existing = db.drizzle
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.path, input.path))
      .get();
    if (existing === undefined) return insertLibraryItem(db, input);
    const row = db.drizzle
      .update(libraryItems)
      .set({ size: input.size, sha256: input.sha256 })
      .where(eq(libraryItems.id, existing.id))
      .returning()
      .get();
    return libraryItemFromRow(row ?? existing);
  })();
}

export function getLibraryItem(db: PsycheDb, id: string): LibraryItem | undefined {
  const row = db.drizzle.select().from(libraryItems).where(eq(libraryItems.id, id)).get();
  return row === undefined ? undefined : libraryItemFromRow(row);
}

/** Newest first. */
export function listLibraryItemsPage(
  db: PsycheDb,
  opts: LibraryPageOptions = {},
): { items: LibraryItem[]; hasMore: boolean } {
  const limit = opts.limit ?? 50;
  const escaped = opts.query?.replace(/[\\%_]/g, (c) => `\\${c}`);
  const filters = [
    opts.kind === undefined ? undefined : eq(libraryItems.kind, opts.kind),
    opts.threadId === undefined ? undefined : eq(libraryItems.threadId, opts.threadId),
    opts.taskId === undefined ? undefined : eq(libraryItems.taskId, opts.taskId),
    escaped === undefined
      ? undefined
      : sql`lower(${libraryItems.name}) LIKE ${`%${escaped.toLowerCase()}%`} ESCAPE '\\'`,
  ];
  const rows = db.drizzle
    .select()
    .from(libraryItems)
    .where(and(...filters))
    .orderBy(desc(libraryItems.createdAt), desc(libraryItems.id))
    .limit(limit + 1)
    .offset(opts.offset ?? 0)
    .all();
  return { items: rows.slice(0, limit).map(libraryItemFromRow), hasMore: rows.length > limit };
}

/** Removes the row; true when one was there. The caller removes the file first. */
export function deleteLibraryItem(db: PsycheDb, id: string): boolean {
  return db.drizzle.delete(libraryItems).where(eq(libraryItems.id, id)).run().changes > 0;
}
