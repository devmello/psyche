import type { SpecialistSpec, TaskEngine } from "@psyche/protocol";
import { FakeTaskEngine } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { THREAD, testEngine } from "./helpers.ts";

/** The specialist pool's claim filters (docs/agent/specialists-2026.md §4.5). */

const spec = (parentThreadId: string): SpecialistSpec => ({
  role: "researcher",
  parentRunId: null,
  parentThreadId,
  rootRunId: null,
  model: "fake/primary",
  tools: [],
  permissionMode: "balanced",
  budget: { limit: {}, used: { steps: 0, tokens: 0, wallMs: 0, costUsd: 0 } },
  deadline: null,
  inputs: { libraryItemIds: [], folders: [], urls: [] },
  deliver: "inbox",
  planFirst: false,
  queuePosition: null,
  result: null,
});

async function seed(engine: TaskEngine) {
  const chat = await engine.create({
    threadId: THREAD,
    title: "chat",
    goal: "g",
    createdFrom: "chat",
  });
  const jobs = [];
  for (const parent of ["thr_a", "thr_a", "thr_a", "thr_b"]) {
    jobs.push(
      await engine.create({
        threadId: THREAD,
        title: `job for ${parent}`,
        goal: "g",
        createdFrom: "subagent",
        specialist: spec(parent),
      }),
    );
  }
  return { chat, jobs };
}

for (const [name, make] of [
  ["SqliteTaskEngine", () => testEngine().engine],
  ["FakeTaskEngine", () => new FakeTaskEngine()],
] as const) {
  describe(`${name} claim filters`, () => {
    it("the chat pool leaves specialist jobs alone", async () => {
      const engine: TaskEngine = make();
      const { chat } = await seed(engine);
      const first = await engine.claim("chat/0", { leaseMs: 60_000, excludeOrigins: ["subagent"] });
      expect(first?.taskId).toBe(chat.id);
      expect(
        await engine.claim("chat/1", { leaseMs: 60_000, excludeOrigins: ["subagent"] }),
      ).toBeUndefined();
    });

    it("the specialist pool takes only jobs, oldest first, at most 2 per parent thread", async () => {
      const engine: TaskEngine = make();
      const { jobs } = await seed(engine);
      const opts = { leaseMs: 60_000, origins: ["subagent" as const], perParentLimit: 2 };
      const claimed = [];
      for (let i = 0; i < 4; i += 1)
        claimed.push((await engine.claim(`specialist/${i}`, opts))?.taskId);
      // thr_a's third job waits: two of its jobs are already running.
      expect(claimed).toEqual([jobs[0]?.id, jobs[1]?.id, jobs[3]?.id, undefined]);
    });
  });
}
