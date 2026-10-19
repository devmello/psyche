import type { Message } from "@psyche/protocol";
import { and, asc, desc, eq, lt, lte } from "drizzle-orm";
import { messageFromRow } from "../mappers.ts";
import type { PsycheDb } from "../open.ts";
import { messages, threads } from "../schema.ts";

export function getMessage(db: PsycheDb, id: string): Message | undefined {
  const row = db.drizzle.select().from(messages).where(eq(messages.id, id)).get();
  return row === undefined ? undefined : messageFromRow(row);
}

/**
 * One page of a transcript, newest first from `beforeSeq` (exclusive), returned in ascending
 * order. `nextBeforeSeq` is the seq to pass for the next (older) page, or `null` at the start.
 */
export function listMessagesPage(
  db: PsycheDb,
  threadId: string,
  opts: { beforeSeq?: number; limit?: number } = {},
): { messages: Message[]; nextBeforeSeq: number | null } {
  const limit = opts.limit ?? 100;
  const rows = db.drizzle
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        opts.beforeSeq === undefined ? undefined : lt(messages.seq, opts.beforeSeq),
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit).reverse();
  const first = page[0];
  return {
    messages: page.map(messageFromRow),
    nextBeforeSeq: rows.length > limit && first !== undefined ? first.seq : null,
  };
}

/** Every message of a thread in order (exports, forks). */
export function listAllMessages(db: PsycheDb, threadId: string, uptoSeq?: number): Message[] {
  return db.drizzle
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        uptoSeq === undefined ? undefined : lte(messages.seq, uptoSeq),
      ),
    )
    .orderBy(asc(messages.seq))
    .all()
    .map(messageFromRow);
}

/**
 * Copies `source`'s messages up to and including `uptoSeq` into `target` (a new fork with no
 * writer). Blocks and provider-native turns are copied verbatim, seqs are kept, ids are new, and
 * reply links are remapped to the copies. Returns the id map (old → new).
 */
export function copyMessagesForFork(
  db: PsycheDb,
  sourceThreadId: string,
  targetThreadId: string,
  uptoSeq: number,
): Map<string, string> {
  const ids = new Map<string, string>();
  db.sqlite.transaction(() => {
    const rows = db.drizzle
      .select()
      .from(messages)
      .where(and(eq(messages.threadId, sourceThreadId), lte(messages.seq, uptoSeq)))
      .orderBy(asc(messages.seq))
      .all();
    let last: string | null = null;
    for (const row of rows) {
      const id = db.newId();
      ids.set(row.id, id);
      db.drizzle
        .insert(messages)
        .values({
          ...row,
          id,
          threadId: targetThreadId,
          replyToMessageId:
            row.replyToMessageId === null ? null : (ids.get(row.replyToMessageId) ?? null),
        })
        .run();
      last = row.createdAt;
    }
    if (last !== null) {
      db.drizzle
        .update(threads)
        .set({ lastMessageAt: last, updatedAt: db.now() })
        .where(eq(threads.id, targetThreadId))
        .run();
    }
  })();
  return ids;
}
