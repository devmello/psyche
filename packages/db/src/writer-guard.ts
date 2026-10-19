/**
 * Transcript write guard (docs/04-data-model.md §2, docs/02-architecture.md §4.2 step 6).
 *
 * `threads.active_writer_run_id` names the one run allowed to append to a thread's transcript.
 * Every append states the writer it expects (`expectedWriterRunId`); the append is rejected with
 * `PsycheError("conflict")` unless that equals the thread's current writer. A run superseded by
 * `interrupt`, cancellation or a retry therefore cannot commit stale output.
 *
 * Rule for `expectedWriterRunId: null`: it means "no run owns this transcript" and succeeds only
 * while `active_writer_run_id IS NULL` (user messages between turns, system notices, imports).
 * Messages recorded while a run is active (a steer, a follow-up queued mid-turn) are written by
 * the session controller with the active run's id as the expectation, after it has decided their
 * place in the queue; nothing else may pass a run id it does not own.
 */
import type { Block, ChannelRef, Message, MessageRole, Provenance } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import { and, eq, sql } from "drizzle-orm";
import { encodeJson, messageFromRow } from "./mappers.ts";
import type { PsycheDb } from "./open.ts";
import { messages, runs, threads } from "./schema.ts";

export interface NewMessage {
  readonly id?: string;
  readonly threadId: string;
  readonly role: MessageRole;
  readonly blocks: readonly Block[];
  readonly providerNative?: unknown;
  readonly provenance: Provenance;
  readonly replyToMessageId?: string | null;
  readonly channelRef?: ChannelRef | null;
  readonly runId?: string | null;
  readonly createdAt?: string;
}

export interface AppendOptions {
  /** The run the caller believes owns the transcript; `null` = no active writer. */
  readonly expectedWriterRunId: string | null;
}

function activeWriter(db: PsycheDb, threadId: string): string | null {
  const row = db.drizzle
    .select({ activeWriterRunId: threads.activeWriterRunId })
    .from(threads)
    .where(eq(threads.id, threadId))
    .get();
  if (row === undefined) throw new PsycheError("not_found", `thread ${threadId} not found`);
  return row.activeWriterRunId;
}

/**
 * Makes `runId` the thread's writer, superseding any previous run. The run must belong to the
 * thread. Returns the previous writer (or `null`).
 */
export function claimWriter(db: PsycheDb, threadId: string, runId: string): string | null {
  return db.sqlite
    .transaction(() => {
      const previous = activeWriter(db, threadId);
      const run = db.drizzle
        .select({ threadId: runs.threadId })
        .from(runs)
        .where(eq(runs.id, runId))
        .get();
      if (run === undefined) throw new PsycheError("not_found", `run ${runId} not found`);
      if (run.threadId !== threadId) {
        throw new PsycheError(
          "invalid_params",
          `run ${runId} does not belong to thread ${threadId}`,
        );
      }
      db.drizzle
        .update(threads)
        .set({ activeWriterRunId: runId, updatedAt: db.now() })
        .where(eq(threads.id, threadId))
        .run();
      return previous;
    })
    .immediate();
}

/** Clears the writer if `runId` still owns the thread. Returns whether it did. */
export function releaseWriter(db: PsycheDb, threadId: string, runId: string): boolean {
  const result = db.drizzle
    .update(threads)
    .set({ activeWriterRunId: null, updatedAt: db.now() })
    .where(and(eq(threads.id, threadId), eq(threads.activeWriterRunId, runId)))
    .run();
  return result.changes > 0;
}

/** The seq the next message of `threadId` would get (seqs start at 1). Informational only. */
export function nextSeq(db: PsycheDb, threadId: string): number {
  const row = db.drizzle
    .select({ max: sql<number | null>`max(${messages.seq})` })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .get();
  return (row?.max ?? 0) + 1;
}

/**
 * Appends a message in one IMMEDIATE transaction: checks the writer guard, assigns
 * `seq = max(seq) + 1`, inserts, and bumps `threads.last_message_at` / `updated_at`.
 * Returns the stored message in protocol shape.
 */
export function appendMessage(db: PsycheDb, msg: NewMessage, opts: AppendOptions): Message {
  return db.sqlite
    .transaction(() => {
      const active = activeWriter(db, msg.threadId);
      if (active !== opts.expectedWriterRunId) {
        throw new PsycheError(
          "conflict",
          `transcript of thread ${msg.threadId} is owned by ${active ?? "no run"}, not ${opts.expectedWriterRunId ?? "no run"}`,
          {
            details: {
              threadId: msg.threadId,
              expectedWriterRunId: opts.expectedWriterRunId,
              activeWriterRunId: active,
            },
          },
        );
      }
      const createdAt = msg.createdAt ?? db.now();
      const row = db.drizzle
        .insert(messages)
        .values({
          id: msg.id ?? db.newId(),
          threadId: msg.threadId,
          seq: nextSeq(db, msg.threadId),
          role: msg.role,
          blocks: JSON.stringify(msg.blocks),
          providerNative: encodeJson(msg.providerNative ?? undefined),
          provenance: msg.provenance,
          replyToMessageId: msg.replyToMessageId ?? null,
          channelRef: encodeJson(msg.channelRef ?? undefined),
          runId: msg.runId ?? null,
          createdAt,
        })
        .returning()
        .get();
      db.drizzle
        .update(threads)
        .set({ lastMessageAt: createdAt, updatedAt: db.now() })
        .where(eq(threads.id, msg.threadId))
        .run();
      return messageFromRow(row);
    })
    .immediate();
}
