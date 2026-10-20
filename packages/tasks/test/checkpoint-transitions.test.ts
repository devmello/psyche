import type { TaskCheckpoint } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { checkpointMayMove } from "../src/index.ts";
import { THREAD, testEngine } from "./helpers.ts";

type Status = TaskCheckpoint["status"];
const INPUT = { threadId: THREAD, title: "t", goal: "g", createdFrom: "chat" as const };
const LEASE = 30_000;
const ALL: Status[] = ["pending", "running", "done", "failed", "uncertain"];
const OPEN: Status[] = ["pending", "running"];

/** A task with step `s` at `from`, written straight to the table (so `uncertain` is reachable). */
async function stepAt(from: Status) {
  const { engine, db, clock } = testEngine();
  const task = await engine.create(INPUT);
  await engine.claim("w", { leaseMs: LEASE });
  await engine.checkpoint(task.id, { stepId: "s", replaySafe: false, status: "pending" });
  db.sqlite
    .prepare("UPDATE task_checkpoints SET status = ? WHERE task_id = ? AND step_id = 's'")
    .run(from, task.id);
  return { engine, db, clock, task };
}

async function statusOf(engine: ReturnType<typeof testEngine>["engine"], taskId: string) {
  return (await engine.checkpoints(taskId)).find((c) => c.stepId === "s")?.status;
}

describe("checkpoint() status transitions (#65)", () => {
  for (const from of ALL) {
    for (const to of ALL) {
      const allowed = from === to || OPEN.includes(from);
      it(`${from} → ${to} is ${allowed ? "allowed" : "rejected"}`, async () => {
        expect(checkpointMayMove(from, to)).toBe(allowed);
        const { engine, task } = await stepAt(from);
        const write = engine.checkpoint(task.id, { stepId: "s", replaySafe: false, status: to });
        if (allowed) {
          expect((await write).status).toBe(to);
          expect(await statusOf(engine, task.id)).toBe(to);
        } else {
          await expect(write).rejects.toMatchObject({ code: "conflict" });
          expect(await statusOf(engine, task.id)).toBe(from);
        }
      });
    }
  }

  it("a re-sent step id after recovery cannot turn an uncertain step back into running", async () => {
    const { engine, clock } = testEngine();
    const task = await engine.create(INPUT);
    await engine.claim("w1", { leaseMs: LEASE });
    const cp = { stepId: "call_0", replaySafe: false, status: "running" as const };
    await engine.checkpoint(task.id, cp);
    clock.advance(LEASE + 1);
    expect(await engine.recoverExpired()).toEqual([task.id]);
    expect((await engine.checkpoints(task.id))[0]?.status).toBe("uncertain");

    expect(await engine.claim("w2", { leaseMs: LEASE })).toBeDefined();
    const err = await engine.checkpoint(task.id, cp).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PsycheError);
    expect((err as PsycheError).code).toBe("conflict");
    expect((await engine.checkpoints(task.id))[0]?.status).toBe("uncertain");

    // reconcile is still the way out of uncertain.
    await engine.reconcile(task.id, "call_0", { status: "done" });
    expect((await engine.checkpoints(task.id))[0]?.status).toBe("done");
  });

  it("the SQL guard holds even if the row settled after the check", async () => {
    const { engine, db, task } = await stepAt("running");
    // Settle the row between the status check and the UPDATE, as a concurrent writer would.
    const prepare = db.sqlite.prepare.bind(db.sqlite);
    db.sqlite.prepare = ((sql: string) => {
      if (sql.startsWith("UPDATE task_checkpoints SET status = @status, replay_safe")) {
        prepare("UPDATE task_checkpoints SET status = 'uncertain' WHERE task_id = ?").run(task.id);
      }
      return prepare(sql);
    }) as typeof db.sqlite.prepare;
    await expect(
      engine.checkpoint(task.id, { stepId: "s", replaySafe: false, status: "done" }),
    ).rejects.toMatchObject({ code: "conflict" });
    // The whole transaction rolled back: the step never became `done`.
    expect(await statusOf(engine, task.id)).toBe("running");
  });
});
