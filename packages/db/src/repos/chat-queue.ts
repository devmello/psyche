import type { QueuedMessage } from "@psyche/protocol";
import { and, asc, eq, sql } from "drizzle-orm";
import { decodeJson } from "../mappers.ts";
import type { PsycheDb } from "../open.ts";
import { type ChatQueueRow, chatQueue } from "../schema.ts";

/** A queued follow-up plus who queued it (the owner, or the agent of another thread, E12). */
export interface QueuedItem extends QueuedMessage {
  provenance: "owner" | "agent";
  fromThreadId: string | null;
}

function fromRow(row: ChatQueueRow): QueuedMessage {
  return {
    messageId: row.id,
    threadId: row.threadId,
    position: row.position,
    content: row.content,
    attachments: decodeJson<string[]>(row.attachments),
    createdAt: row.createdAt,
  };
}

export interface NewQueuedMessage {
  readonly id?: string;
  readonly threadId: string;
  readonly content: string;
  readonly attachments?: readonly string[];
  readonly deviceId?: string | null;
  readonly provenance?: "owner" | "agent";
  readonly fromThreadId?: string | null;
}

/** Appends a follow-up at the end of the thread's queue. */
export function enqueueMessage(db: PsycheDb, input: NewQueuedMessage): QueuedMessage {
  const at = db.now();
  const max = db.drizzle
    .select({ max: sql<number | null>`max(${chatQueue.position})` })
    .from(chatQueue)
    .where(eq(chatQueue.threadId, input.threadId))
    .get();
  const row = db.drizzle
    .insert(chatQueue)
    .values({
      id: input.id ?? db.newId(),
      threadId: input.threadId,
      position: (max?.max ?? -1) + 1,
      content: input.content,
      attachments: JSON.stringify(input.attachments ?? []),
      deviceId: input.deviceId ?? null,
      provenance: input.provenance ?? "owner",
      fromThreadId: input.fromThreadId ?? null,
      status: "queued",
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get();
  return fromRow(row);
}

export function listQueue(db: PsycheDb, threadId: string): QueuedMessage[] {
  return db.drizzle
    .select()
    .from(chatQueue)
    .where(and(eq(chatQueue.threadId, threadId), eq(chatQueue.status, "queued")))
    .orderBy(asc(chatQueue.position))
    .all()
    .map(fromRow);
}

/** Removes a still-queued item; `false` when it started already or is unknown. */
export function removeQueued(db: PsycheDb, threadId: string, id: string): boolean {
  return (
    db.drizzle
      .update(chatQueue)
      .set({ status: "removed", updatedAt: db.now() })
      .where(
        and(eq(chatQueue.id, id), eq(chatQueue.threadId, threadId), eq(chatQueue.status, "queued")),
      )
      .run().changes > 0
  );
}

/** Marks the head of the queue started and returns it (call in the transaction that runs it). */
export function takeNextQueued(db: PsycheDb, threadId: string): QueuedItem | undefined {
  const head = db.drizzle
    .select()
    .from(chatQueue)
    .where(and(eq(chatQueue.threadId, threadId), eq(chatQueue.status, "queued")))
    .orderBy(asc(chatQueue.position))
    .limit(1)
    .get();
  if (head === undefined) return undefined;
  db.drizzle
    .update(chatQueue)
    .set({ status: "started", updatedAt: db.now() })
    .where(eq(chatQueue.id, head.id))
    .run();
  return {
    ...fromRow(head),
    provenance: head.provenance === "agent" ? "agent" : "owner",
    fromThreadId: head.fromThreadId,
  };
}

/** Threads that have queued follow-ups (boot drains them). */
export function threadsWithQueuedMessages(db: PsycheDb): string[] {
  return db.drizzle
    .selectDistinct({ threadId: chatQueue.threadId })
    .from(chatQueue)
    .where(eq(chatQueue.status, "queued"))
    .all()
    .map((r) => r.threadId);
}
