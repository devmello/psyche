import { Message } from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  appendMessage,
  claimWriter,
  createRun,
  createThread,
  getMessage,
  listMessagesPage,
  setRunLessonsApplied,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

/**
 * `messages.lessons_applied` (teaching loop §5.1, 202610261000): the lessons the Gateway put in
 * a run's prompt, set on that run's agent messages after the run and read back as
 * `Message.lessonsApplied`. Other runs' and the owner's messages are untouched.
 */
describe("messages.lessons_applied", () => {
  it("is set on the run's agent messages only and round-trips through the mapper", () => {
    const db = memoryDb();
    const thread = createThread(db, { kind: "main", sessionKey: "main:t" });
    const run = createRun(db, { threadId: thread.id, modelRef: "fake/model" });
    const other = createRun(db, { threadId: thread.id, modelRef: "fake/model" });
    const user = appendMessage(
      db,
      {
        threadId: thread.id,
        role: "user",
        blocks: [{ type: "text", md: "hi" }],
        provenance: "owner",
      },
      { expectedWriterRunId: null },
    );
    claimWriter(db, thread.id, run.id);
    const agent = appendMessage(
      db,
      {
        threadId: thread.id,
        role: "agent",
        blocks: [{ type: "text", md: "Hi Jane" }],
        provenance: "agent",
        runId: run.id,
      },
      { expectedWriterRunId: run.id },
    );
    const refs = [
      { lessonId: "ls_01abcdefgh", statement: "Open with 'Hi Jane'.", kind: "style" as const },
    ];
    expect(setRunLessonsApplied(db, other.id, refs)).toEqual([]);
    const updated = setRunLessonsApplied(db, run.id, refs);
    expect(updated.map((m) => m.id)).toEqual([agent.id]);
    expect(getMessage(db, agent.id)?.lessonsApplied).toEqual(refs);
    expect(getMessage(db, user.id)?.lessonsApplied).toBeUndefined();
    expect(setRunLessonsApplied(db, run.id, [])).toEqual([]);
    // The wire shape still validates, with and without the field.
    for (const m of listMessagesPage(db, thread.id).messages)
      expect(Value.Check(Message, m)).toBe(true);
  });
});
