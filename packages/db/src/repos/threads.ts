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
