import { createThread, openDb } from "@psyche/db";
import type { SpecialistSpec } from "@psyche/protocol";
import { SqliteTaskEngine } from "@psyche/tasks";
import { createIdGenerator, FakeClock, FakePermissionBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { withSpecialistContext } from "../src/compose/specialist-approvals.ts";
import type { RoleSource } from "../src/compose/specialists.ts";
import { taskUpdateHandlers } from "../src/compose/task-controls.ts";

const roles: RoleSource = {
  specialistRoles: async () =>
    [
      {
        role: {
          role: "shopper",
          budget: { tokens: 100_000, costUsd: 1, minutes: 20 },
          caps: { tokens: 500_000, costUsd: 5, minutes: 120, maxHours: 24 },
        },
      },
    ] as never,
};

const spec: SpecialistSpec = {
  role: "shopper",
  parentRunId: "run_parent",
  parentThreadId: "thr_parent",
  rootRunId: "run_parent",
  model: "fake/primary",
  tools: ["web_search"],
  permissionMode: "balanced",
  budget: {
    limit: { tokens: 100_000, costUsd: 1, wallMs: 20 * 60_000 },
    used: { steps: 4, tokens: 100_000, wallMs: 60_000, costUsd: 0.4 },
  },
  deadline: null,
  inputs: { libraryItemIds: [], folders: [], urls: [] },
  deliver: "inbox",
  planFirst: false,
  queuePosition: null,
  result: null,
};

function setup() {
  const clock = new FakeClock();
  const ids = createIdGenerator({ prefix: "db" });
  const db = openDb(":memory:", {
    now: () => new Date(clock.now()).toISOString(),
    newId: () => ids.next(),
  });
  createThread(db, { id: "thr_parent", kind: "main", sessionKey: "main:parent" });
  createThread(db, { id: "thr_child", kind: "subagent", sessionKey: "specialist:shopper:1" });
  const tasks = new SqliteTaskEngine({ db, clock });
  const pokes = { n: 0 };
  const h = taskUpdateHandlers({
    tasks,
    roles,
    now: () => clock.now(),
    poke: () => {
      pokes.n += 1;
    },
  });
  const job = () =>
    tasks.create({
      threadId: "thr_child",
      title: "Laptops under $1,000",
      goal: "Compare three laptops",
      createdFrom: "subagent",
      specialist: spec,
    });
  return { clock, tasks, h, job, pokes };
}

describe("tasks.update (specialists §4.7)", () => {
  it("raises the budget, capped by the role, and keeps what it left out", async () => {
    const { tasks, h, job, pokes } = setup();
    const t = await job();
    const { task } = await h["tasks.update"]({
      taskId: t.id,
      budget: { tokens: 150_000, costUsd: 50 },
    });
    expect(task.specialist?.budget.limit).toEqual({
      tokens: 150_000,
      costUsd: 5,
      wallMs: 1_200_000,
    });
    expect(task.specialist?.budget.used.tokens).toBe(100_000);
    expect(pokes.n).toBe(1);
    expect((await tasks.actions(t.id)).at(-1)?.level1).toBe("You gave it more budget");
  });

  it("moves the deadline, never past maxHours after the job started", async () => {
    const { clock, h, job } = setup();
    const t = await job();
    const far = new Date(clock.now() + 72 * 3_600_000).toISOString();
    const { task } = await h["tasks.update"]({ taskId: t.id, deadline: far });
    expect(task.specialist?.deadline).toBe(new Date(clock.now() + 24 * 3_600_000).toISOString());
    await expect(
      h["tasks.update"]({ taskId: t.id, deadline: new Date(clock.now() - 1).toISOString() }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("refuses tasks that are not specialists' jobs, and finished jobs", async () => {
    const { tasks, h, job } = setup();
    const plain = await tasks.create({
      threadId: "thr_parent",
      title: "Chat task",
      goal: "x",
      createdFrom: "chat",
    });
    await expect(
      h["tasks.update"]({ taskId: plain.id, budget: { tokens: 10 } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    const t = await job();
    await tasks.cancel(t.id);
    await expect(h["tasks.update"]({ taskId: t.id, budget: { tokens: 10 } })).rejects.toMatchObject(
      { code: "conflict" },
    );
  });
});

describe("approvals carry the specialist's parent context (§4.4)", () => {
  it("adds parentRunId and the role for a specialist's task, and leaves others alone", async () => {
    const { clock, tasks, job } = setup();
    const t = await job();
    const broker = withSpecialistContext(new FakePermissionBroker({ clock }), (id) =>
      tasks.get(id),
    );
    const ask = (taskId: string | null) =>
      broker.requestApproval({
        kind: "new_origin",
        summary: "Open shop.example",
        details: {},
        bindingHash: `sha256:${"ab".repeat(32)}`,
        grantKey: "browser.navigate|shop.example",
        requestedBy: { runId: "run_child", taskId, threadId: "thr_child" },
        sideEffect: "read",
        surfaces: ["desktop"],
        taint: false,
      });
    expect((await ask(t.id)).approval.requestedBy).toMatchObject({
      taskId: t.id,
      parentRunId: "run_parent",
      specialist: "shopper",
    });
    const plain = (await ask(null)).approval.requestedBy;
    expect(plain.specialist).toBeUndefined();
    expect(plain.parentRunId).toBeUndefined();
  });
});
