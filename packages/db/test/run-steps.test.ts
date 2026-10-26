import type { RunStep } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  addRunFrame,
  countRunSteps,
  createRun,
  createThread,
  deleteRunTrace,
  expireRunFramesBefore,
  expireRunStepText,
  getRun,
  getRunStep,
  lastRunStepSeq,
  listRunFrames,
  listRunSteps,
  listRuns,
  type PsycheDb,
  patchRunTrace,
  putToolPayload,
  stepPayloads,
  upsertRunStep,
  upsertToolCall,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

/** Run trace store (docs/design/run-trace-2026.md §4.2–§4.3). */

let db: PsycheDb;
afterEach(() => db?.close());

function setup() {
  db = memoryDb();
  const thread = createThread(db, { kind: "main", sessionKey: "owner:main", title: "Main" });
  const run = createRun(db, {
    threadId: thread.id,
    modelRef: "anthropic/claude-opus-5-5",
    kind: "chat",
    origin: "owner",
  });
  return { thread, run };
}

const step = (runId: string, seq: number, extra: Partial<RunStep> = {}): RunStep => ({
  id: `stp_${seq}`,
  runId,
  seq,
  kind: "tool",
  status: "running",
  label: "Searching",
  startedAt: "2026-10-18T22:00:01.000Z",
  endedAt: null,
  attempt: 1,
  ...extra,
});

describe("run_steps", () => {
  it("stores steps in seq order, upserts by id, and keeps thinking text out of lists", () => {
    const { run } = setup();
    upsertRunStep(db, step(run.id, 2));
    upsertRunStep(
      db,
      step(run.id, 1, {
        id: "rsn_1",
        kind: "thinking",
        status: "ok",
        text: { summary: "Plan", full: "The whole plan", expiresAt: "2026-10-25T22:00:00.000Z" },
      }),
    );
    upsertRunStep(db, step(run.id, 2, { status: "ok", endedAt: "2026-10-18T22:00:02.000Z" }));
    expect(listRunSteps(db, run.id).map((s) => [s.seq, s.id, s.status])).toEqual([
      [1, "rsn_1", "ok"],
      [2, "stp_2", "ok"],
    ]);
    expect(listRunSteps(db, run.id)[0]?.text).toEqual({
      summary: "Plan",
      expiresAt: "2026-10-25T22:00:00.000Z",
    });
    expect(getRunStep(db, run.id, "rsn_1")?.text?.full).toBe("The whole plan");
    // An update without the text keeps it.
    upsertRunStep(
      db,
      step(run.id, 1, { id: "rsn_1", kind: "thinking", status: "ok", text: { summary: "Plan" } }),
    );
    expect(getRunStep(db, run.id, "rsn_1")?.text?.full).toBe("The whole plan");
    expect(listRunSteps(db, run.id, { afterSeq: 1 }).map((s) => s.seq)).toEqual([2]);
    expect(countRunSteps(db, run.id)).toBe(2);
    expect(lastRunStepSeq(db, run.id)).toBe(2);
  });

  it("expires thinking text but keeps the summary and expiresAt", () => {
    const { run } = setup();
    upsertRunStep(
      db,
      step(run.id, 1, {
        id: "rsn_1",
        kind: "thinking",
        text: {
          summary: "Plan",
          full: "secret-free reasoning",
          expiresAt: "2026-10-19T00:00:00.000Z",
        },
      }),
    );
    expect(expireRunStepText(db, "2026-10-18T23:00:00.000Z")).toBe(0);
    expect(expireRunStepText(db, "2026-10-20T00:00:00.000Z")).toBe(1);
    expect(getRunStep(db, run.id, "rsn_1")?.text).toEqual({
      summary: "Plan",
      expiresAt: "2026-10-19T00:00:00.000Z",
    });
  });

  it("patches the run's trace fields and lists runs with filters", () => {
    const { thread, run } = setup();
    const child = createRun(db, {
      threadId: thread.id,
      modelRef: "anthropic/claude-opus-5-5",
      kind: "subagent",
      parentRunId: run.id,
      rootRunId: run.id,
      title: "Helper",
    });
    patchRunTrace(db, run.id, { stepCount: 3, currentStepId: "stp_3", title: "Lisbon" });
    expect(getRun(db, run.id)).toMatchObject({ kind: "chat", stepCount: 3, title: "Lisbon" });
    expect(listRuns(db, { parentRunId: run.id, limit: 10 }).map((r) => r.id)).toEqual([child.id]);
    expect(listRuns(db, { kind: "chat", limit: 10 }).map((r) => r.id)).toEqual([run.id]);
    expect(listRuns(db, { limit: 10 })).toHaveLength(2);
  });
});

describe("frames, payloads and delete", () => {
  it("numbers frames per run, expires old files, and deletes a trace but not the run", () => {
    const { run } = setup();
    const a = addRunFrame(db, {
      runId: run.id,
      at: "2026-10-10T00:00:00.000Z",
      stepId: "stp_1",
      width: 1280,
      height: 800,
      path: "frames/1.jpg",
    });
    const b = addRunFrame(db, {
      runId: run.id,
      at: "2026-10-18T22:00:00.000Z",
      stepId: "stp_2",
      width: 1280,
      height: 800,
      path: "frames/2.jpg",
    });
    expect([a, b]).toEqual([1, 2]);
    expect(listRunFrames(db, run.id, { stepId: "stp_2" }).map((f) => f.seq)).toEqual([2]);
    expect(
      expireRunFramesBefore(db, "2026-10-11T00:00:00.000Z", "2026-10-18T22:00:00.000Z"),
    ).toEqual([{ runId: run.id, seq: 1, path: "frames/1.jpg" }]);
    expect(listRunFrames(db, run.id)[0]).toMatchObject({ seq: 1, expired: true, path: null });

    upsertToolCall(db, {
      id: "tc_1",
      runId: run.id,
      tool: "web.search",
      status: "ok",
      stepId: "stp_1",
    });
    upsertRunStep(db, step(run.id, 1, { id: "stp_1", toolCallId: "tc_1" }));
    putToolPayload(db, {
      toolCallId: "tc_1",
      stepId: "stp_1",
      kind: "params",
      mime: "application/json",
      data: new TextEncoder().encode('{"q":"SFO"}'),
    });
    putToolPayload(db, {
      toolCallId: "tc_1",
      stepId: "stp_1",
      kind: "result",
      mime: "text/plain",
      data: new TextEncoder().encode("5 flights"),
      truncated: true,
    });
    expect(stepPayloads(db, "stp_1")).toEqual({
      input: { q: "SFO" },
      output: "5 flights",
      truncated: true,
    });

    expect(deleteRunTrace(db, run.id)).toEqual(["frames/2.jpg"]);
    expect(listRunSteps(db, run.id)).toEqual([]);
    expect(listRunFrames(db, run.id)).toEqual([]);
    expect(stepPayloads(db, "stp_1")).toEqual({ truncated: false });
    expect(getRun(db, run.id)?.id).toBe(run.id);
  });
});
