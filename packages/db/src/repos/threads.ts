import type { PermissionMode, Thread, ThreadKind } from "@psyche/protocol";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { fromBool, threadFromRow } from "../mappers.ts";
import type { PsycheDb } from "../open.ts";
import { threads } from "../schema.ts";

export interface NewThread {
  readonly id?: string;
  readonly kind: ThreadKind;
  readonly sessionKey: string;
  readonly title?: string;
  readonly titleSource?: Thread["titleSource"];
  readonly parentThreadId?: string | null;
  readonly forkedFromMessageId?: string | null;
  readonly personaOverlay?: string | null;
  readonly permissionMode?: PermissionMode;
  readonly modelRef?: string | null;
  readonly pinned?: boolean;
  readonly expiresAt?: string | null;
}

export function createThread(db: PsycheDb, input: NewThread): Thread {
  const at = db.now();
  const row = db.drizzle
    .insert(threads)
    .values({
      id: input.id ?? db.newId(),
      kind: input.kind,
      title: input.title ?? "",
      titleSource: input.titleSource ?? (input.title === undefined ? "auto" : "user"),
      parentThreadId: input.parentThreadId ?? null,
      forkedFromMessageId: input.forkedFromMessageId ?? null,
      sessionKey: input.sessionKey,
      personaOverlay: input.personaOverlay ?? null,
      permissionMode: input.permissionMode ?? "balanced",
      modelRef: input.modelRef ?? null,
      pinned: fromBool(input.pinned),
      expiresAt: input.expiresAt ?? null,
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get();
  return threadFromRow(row);
}

export function getThread(db: PsycheDb, id: string): Thread | undefined {
  const row = db.drizzle.select().from(threads).where(eq(threads.id, id)).get();
  return row === undefined ? undefined : threadFromRow(row);
}

export interface ListThreadsOptions {
  readonly includeArchived?: boolean;
  readonly kind?: ThreadKind;
  readonly limit?: number;
}

/** Pinned first, then most recently active (`last_message_at`, falling back to `created_at`). */
export function listThreads(db: PsycheDb, opts: ListThreadsOptions = {}): Thread[] {
  const filters = [
    opts.includeArchived ? undefined : isNull(threads.archivedAt),
    opts.kind === undefined ? undefined : eq(threads.kind, opts.kind),
  ];
  const rows = db.drizzle
    .select()
    .from(threads)
    .where(and(...filters))
    .orderBy(
      desc(threads.pinned),
      desc(sql`coalesce(${threads.lastMessageAt}, ${threads.createdAt})`),
      desc(threads.id),
    )
    .limit(opts.limit ?? -1)
    .all();
  return rows.map(threadFromRow);
}

export interface ThreadPatch {
  readonly title?: string;
  readonly titleSource?: Thread["titleSource"];
  readonly pinned?: boolean;
  readonly archivedAt?: string | null;
  readonly permissionMode?: PermissionMode;
  readonly modelRef?: string | null;
}

/** Applies a patch; `undefined` if the thread does not exist. */
export function updateThread(db: PsycheDb, id: string, patch: ThreadPatch): Thread | undefined {
  const set: Partial<typeof threads.$inferInsert> = { updatedAt: db.now() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.titleSource !== undefined) set.titleSource = patch.titleSource;
  if (patch.pinned !== undefined) set.pinned = fromBool(patch.pinned);
  if (patch.archivedAt !== undefined) set.archivedAt = patch.archivedAt;
  if (patch.permissionMode !== undefined) set.permissionMode = patch.permissionMode;
  if (patch.modelRef !== undefined) set.modelRef = patch.modelRef;
  const row = db.drizzle.update(threads).set(set).where(eq(threads.id, id)).returning().get();
  return row === undefined ? undefined : threadFromRow(row);
}

/** Deletes a thread; messages, runs, tool calls and queued follow-ups cascade. */
export function deleteThread(db: PsycheDb, id: string): boolean {
  return db.drizzle.delete(threads).where(eq(threads.id, id)).run().changes > 0;
}

/** The newest non-archived thread of `kind` with `sessionKey` (e.g. the owner's main thread). */
export function findThreadBySessionKey(
  db: PsycheDb,
  sessionKey: string,
  kind: ThreadKind,
): Thread | undefined {
  const row = db.drizzle
    .select()
    .from(threads)
    .where(
      and(eq(threads.sessionKey, sessionKey), eq(threads.kind, kind), isNull(threads.archivedAt)),
    )
    .orderBy(desc(threads.createdAt))
    .limit(1)
    .get();
  return row === undefined ? undefined : threadFromRow(row);
}

export interface ThreadPageOptions extends ListThreadsOptions {
  readonly pinnedOnly?: boolean;
  /** Case-insensitive substring of the title. */
  readonly query?: string;
  /** Offset cursor from a previous page. */
  readonly offset?: number;
}

/** One page in `listThreads` order; `hasMore` tells the caller whether to hand out a cursor. */
export function listThreadsPage(
  db: PsycheDb,
  opts: ThreadPageOptions,
): { threads: Thread[]; hasMore: boolean } {
  const limit = opts.limit ?? 50;
  const escaped = opts.query?.replace(/[\\%_]/g, (c) => `\\${c}`);
  const filters = [
    opts.includeArchived ? undefined : isNull(threads.archivedAt),
    opts.kind === undefined ? undefined : eq(threads.kind, opts.kind),
    opts.pinnedOnly ? eq(threads.pinned, 1) : undefined,
    escaped === undefined
      ? undefined
      : sql`lower(${threads.title}) LIKE ${`%${escaped.toLowerCase()}%`} ESCAPE '\\'`,
  ];
  const rows = db.drizzle
    .select()
    .from(threads)
    .where(and(...filters))
    .orderBy(
      desc(threads.pinned),
      desc(sql`coalesce(${threads.lastMessageAt}, ${threads.createdAt})`),
      desc(threads.id),
    )
    .limit(limit + 1)
    .offset(opts.offset ?? 0)
    .all();
  return { threads: rows.slice(0, limit).map(threadFromRow), hasMore: rows.length > limit };
}

export interface ThreadActivityCounts {
  running: number;
  awaitingInput: number;
  awaitingApproval: number;
}

/** Derived activity per thread from its runs (architecture §11 `threads.list`). */
export function threadActivity(
  db: PsycheDb,
  threadIds: readonly string[],
): Map<string, ThreadActivityCounts> {
  const out = new Map<string, ThreadActivityCounts>();
  for (const id of threadIds) out.set(id, { running: 0, awaitingInput: 0, awaitingApproval: 0 });
  if (threadIds.length === 0) return out;
  const rows = db.sqlite
    .prepare(
      `SELECT thread_id AS threadId, status, count(*) AS n FROM runs
       WHERE status IN ('running', 'awaiting_input', 'awaiting_approval')
         AND thread_id IN (${threadIds.map(() => "?").join(",")})
       GROUP BY thread_id, status`,
    )
    .all(...threadIds) as { threadId: string; status: string; n: number }[];
  for (const row of rows) {
    const counts = out.get(row.threadId);
    if (counts === undefined) continue;
    if (row.status === "running") counts.running = row.n;
    else if (row.status === "awaiting_input") counts.awaitingInput = row.n;
    else counts.awaitingApproval = row.n;
  }
  return out;
}

/** Threads whose `expires_at` has passed (incognito expiry, data model §12). */
export function listExpiredThreads(db: PsycheDb, now: string): Thread[] {
  return db.drizzle
    .select()
    .from(threads)
    .where(sql`${threads.expiresAt} IS NOT NULL AND ${threads.expiresAt} <= ${now}`)
    .all()
    .map(threadFromRow);
}
