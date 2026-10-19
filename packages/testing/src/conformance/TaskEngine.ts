import type { TaskCreateInput, TaskEngine } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { type ConformanceFactory, expectPsycheError, newContext } from "./harness.ts";

const INPUT: TaskCreateInput = {
  threadId: "thr_conf",
  title: "Book a table",
  goal: "Book a table for two on Friday",
  createdFrom: "chat",
};
const LEASE = 30_000;

/** Architecture §4.5: lifecycle, leases, recovery, parking. */
export function describeTaskEngineConformance(
  name: string,
  factory: ConformanceFactory<TaskEngine>,
): void {
  const setup = async () => {
    const ctx = newContext();
    return { engine: await factory(ctx), clock: ctx.clock };
  };

  describe(`TaskEngine conformance: ${name}`, () => {
    it("creates queued tasks and lists them by status", async () => {
      const { engine } = await setup();
      const task = await engine.create(INPUT);
      expect(task.status).toBe("queued");
      expect((await engine.get(task.id))?.title).toBe(INPUT.title);
      expect((await engine.list({ status: ["queued"] })).map((t) => t.id)).toContain(task.id);
      expect(await engine.list({ status: ["done"] })).toHaveLength(0);
    });

    it("leases are exclusive until they expire", async () => {
      const { engine, clock } = await setup();
      const task = await engine.create(INPUT);
      const lease = await engine.claim("worker-a", { leaseMs: LEASE });
      expect(lease?.taskId).toBe(task.id);
      expect((await engine.get(task.id))?.status).toBe("running");
      expect(await engine.claim("worker-b", { leaseMs: LEASE })).toBeUndefined();

      clock.advance(LEASE + 1);
      const stolen = await engine.claim("worker-b", { leaseMs: LEASE });
      expect(stolen?.taskId).toBe(task.id);
      expect(stolen?.owner).toBe("worker-b");
      if (lease !== undefined) await expectPsycheError(engine.renew(lease, LEASE), "conflict");
      const t = await engine.get(task.id);
      expect(t?.leaseOwner).toBe("worker-b");
      expect(t?.attempt).toBeGreaterThanOrEqual(2);
    });

    it("renew extends and release re-queues", async () => {
      const { engine, clock } = await setup();
      await engine.create(INPUT);
      const lease = await engine.claim("w", { leaseMs: LEASE });
      if (lease === undefined) throw new Error("no lease");
      clock.advance(LEASE - 1_000);
      const renewed = await engine.renew(lease, LEASE);
      expect(renewed.until).toBeGreaterThan(lease.until);
      clock.advance(5_000);
      expect(await engine.claim("other", { leaseMs: LEASE })).toBeUndefined();
      await engine.release(renewed);
      expect((await engine.claim("other", { leaseMs: LEASE }))?.taskId).toBe(lease.taskId);
    });

    it("in-flight unsafe steps become uncertain after a crash", async () => {
      const { engine, clock } = await setup();
      const task = await engine.create(INPUT);
      await engine.claim("crashy", { leaseMs: LEASE });
      await engine.checkpoint(task.id, { stepId: "search", replaySafe: true, status: "done" });
      await engine.checkpoint(task.id, { stepId: "pay", replaySafe: false, status: "running" });
      clock.advance(LEASE + 1);
      await engine.claim("recovery", { leaseMs: LEASE });
      const cps = await engine.checkpoints(task.id);
      expect(cps.find((c) => c.stepId === "pay")?.status).toBe("uncertain");
      expect(cps.find((c) => c.stepId === "search")?.status).toBe("done");
    });

    it("parks on input requests and resumes on answer", async () => {
      const { engine } = await setup();
      const task = await engine.create(INPUT);
      const req = await engine.requestInput(task.id, [
        {
          question: "Which time?",
          header: "Time",
          options: [{ label: "7pm" }, { label: "8pm" }],
          multiSelect: false,
        },
      ]);
      expect((await engine.get(task.id))?.status).toBe("awaiting_input");
      expect(await engine.claim("w", { leaseMs: LEASE })).toBeUndefined();
      const answered = await engine.answerInput(
        req.id,
        { "Which time?": "7pm" },
        { deviceId: "dev_1" },
      );
      expect(answered.status).toBe("answered");
      expect((await engine.get(task.id))?.status).toBe("queued");
      await expectPsycheError(engine.answerInput(req.id, { "Which time?": "8pm" }), "conflict");
    });

    it("cancel is terminal; retry re-queues", async () => {
      const { engine } = await setup();
      const task = await engine.create(INPUT);
      await engine.cancel(task.id, "user stopped it");
      expect((await engine.get(task.id))?.status).toBe("cancelled");
      await expectPsycheError(engine.updateStatus(task.id, "running"), "conflict");
      expect(await engine.claim("w", { leaseMs: LEASE })).toBeUndefined();
      expect((await engine.retry(task.id)).status).toBe("queued");
      expect((await engine.claim("w", { leaseMs: LEASE }))?.taskId).toBe(task.id);
    });

    it("pause and resume", async () => {
      const { engine } = await setup();
      const task = await engine.create(INPUT);
      expect((await engine.pause(task.id)).status).toBe("paused");
      expect(await engine.claim("w", { leaseMs: LEASE })).toBeUndefined();
      expect((await engine.resume(task.id)).status).toBe("queued");
    });

    it("keeps an ordered activity log", async () => {
      const { engine } = await setup();
      const task = await engine.create(INPUT);
      await engine.addAction(task.id, {
        level1: "Opened opentable.com",
        level2: { tool: "browser.navigate" },
      });
      await engine.addAction(task.id, {
        level1: "Searched Friday 7pm",
        level2: { tool: "browser.type" },
      });
      const actions = await engine.actions(task.id);
      expect(actions.map((a) => a.idx)).toEqual([0, 1]);
      expect(actions[1]?.level1).toBe("Searched Friday 7pm");
    });

    it("unknown tasks are not_found", async () => {
      const { engine } = await setup();
      await expectPsycheError(engine.updateStatus("task_missing", "done"), "not_found");
      expect(await engine.get("task_missing")).toBeUndefined();
    });
  });
}
