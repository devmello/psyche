import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  appendMessage,
  claimWriter,
  createRun,
  createThread,
  getThread,
  type NewMessage,
  nextSeq,
  type PsycheDb,
  releaseWriter,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

const MODEL = "anthropic/claude-sonnet-5-5";

function setup(): { db: PsycheDb; threadId: string } {
  const db = memoryDb();
  const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
  return { db, threadId: thread.id };
}

function text(threadId: string, md: string, runId: string | null = null): NewMessage {
  return {
    threadId,
    role: runId === null ? "user" : "agent",
    blocks: [{ type: "text", md }],
    provenance: runId === null ? "owner" : "agent",
    runId,
  };
}

function conflictOf(fn: () => unknown): PsycheError {
  try {
    fn();
  } catch (err) {
    if (err instanceof PsycheError) return err;
    throw err;
  }
  throw new Error("expected a PsycheError");
}

describe("transcript writer guard", () => {
  it("lets a user message in when no writer is active and assigns seq from 1", () => {
    const { db, threadId } = setup();
    expect(nextSeq(db, threadId)).toBe(1);
    const m = appendMessage(db, text(threadId, "hi"), { expectedWriterRunId: null });
    expect(m.seq).toBe(1);
    expect(getThread(db, threadId)?.lastMessageAt).toBe(m.createdAt);
    expect(nextSeq(db, threadId)).toBe(2);
  });

  it("claims, appends with the matching writer, increments seq and releases", () => {
    const { db, threadId } = setup();
    appendMessage(db, text(threadId, "hi"), { expectedWriterRunId: null });
    const run = createRun(db, { threadId, modelRef: MODEL });
    expect(claimWriter(db, threadId, run.id)).toBeNull();
    expect(getThread(db, threadId)?.activeWriterRunId).toBe(run.id);

    const a = appendMessage(db, text(threadId, "one", run.id), { expectedWriterRunId: run.id });
    const b = appendMessage(db, text(threadId, "two", run.id), { expectedWriterRunId: run.id });
    expect([a.seq, b.seq]).toEqual([2, 3]);

    // a null expectation is refused while a run owns the transcript
    expect(
      conflictOf(() => appendMessage(db, text(threadId, "x"), { expectedWriterRunId: null })).code,
    ).toBe("conflict");

    expect(releaseWriter(db, threadId, run.id)).toBe(true);
    expect(releaseWriter(db, threadId, run.id)).toBe(false);
    expect(getThread(db, threadId)?.activeWriterRunId).toBeNull();
    // and a released run cannot append any more
    expect(
      conflictOf(() =>
        appendMessage(db, text(threadId, "late", run.id), { expectedWriterRunId: run.id }),
      ).code,
    ).toBe("conflict");
  });

  it("rejects a superseded run after a new run claims the thread", () => {
    const { db, threadId } = setup();
    const oldRun = createRun(db, { threadId, modelRef: MODEL });
    const newRun = createRun(db, { threadId, modelRef: MODEL, attempt: 2 });
    claimWriter(db, threadId, oldRun.id);
    appendMessage(db, text(threadId, "partial", oldRun.id), { expectedWriterRunId: oldRun.id });

    expect(claimWriter(db, threadId, newRun.id)).toBe(oldRun.id);
    const err = conflictOf(() =>
      appendMessage(db, text(threadId, "stale", oldRun.id), { expectedWriterRunId: oldRun.id }),
    );
    expect(err.code).toBe("conflict");
    expect(err.details).toEqual({
      threadId,
      expectedWriterRunId: oldRun.id,
      activeWriterRunId: newRun.id,
    });
    // the old run cannot release the new run's claim either
    expect(releaseWriter(db, threadId, oldRun.id)).toBe(false);

    const fresh = appendMessage(db, text(threadId, "fresh", newRun.id), {
      expectedWriterRunId: newRun.id,
    });
    expect(fresh.seq).toBe(2);
    const stored = db.sqlite
      .prepare("SELECT seq FROM messages WHERE thread_id = ? ORDER BY seq")
      .all(threadId);
    expect(stored).toEqual([{ seq: 1 }, { seq: 2 }]);
  });

  it("works across two connections to the same file (concurrent claim)", async () => {
    const { makeTmpDir, fakeClock } = await import("./helpers.ts");
    const { openDb } = await import("../src/index.ts");
    const tmp = makeTmpDir();
    try {
      const file = `${tmp.dir}/psyche.sqlite`;
      const a = openDb(file, { now: fakeClock() });
      const b = openDb(file, { now: fakeClock(Date.parse("2026-10-18T23:00:00.000Z")) });
      const thread = createThread(a, { kind: "main", sessionKey: "owner:main" });
      const r1 = createRun(a, { threadId: thread.id, modelRef: MODEL });
      claimWriter(a, thread.id, r1.id);
      const r2 = createRun(b, { threadId: thread.id, modelRef: MODEL, attempt: 2 });
      claimWriter(b, thread.id, r2.id);
      expect(
        conflictOf(() =>
          appendMessage(a, text(thread.id, "stale", r1.id), { expectedWriterRunId: r1.id }),
        ).code,
      ).toBe("conflict");
      expect(
        appendMessage(b, text(thread.id, "ok", r2.id), { expectedWriterRunId: r2.id }).seq,
      ).toBe(1);
      a.close();
      b.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("refuses to claim for a run of another thread or an unknown thread", () => {
    const { db, threadId } = setup();
    const other = createThread(db, { kind: "side", sessionKey: "owner:side" });
    const run = createRun(db, { threadId: other.id, modelRef: MODEL });
    expect(conflictOf(() => claimWriter(db, threadId, run.id)).code).toBe("invalid_params");
    expect(conflictOf(() => claimWriter(db, "nope", run.id)).code).toBe("not_found");
    expect(
      conflictOf(() => appendMessage(db, text("nope", "x"), { expectedWriterRunId: null })).code,
    ).toBe("not_found");
  });
});
