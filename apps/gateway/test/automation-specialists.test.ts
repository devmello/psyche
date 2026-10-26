import { createThread, openDb } from "@psyche/db";
import type { Automation, AutomationRun } from "@psyche/protocol";
import type { RunLauncher } from "@psyche/scheduler";
import { SqliteTaskEngine } from "@psyche/tasks";
import { createIdGenerator, FakeClock, FakePermissionBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { withAutomationSpecialists } from "../src/compose/automation-specialists.ts";
import { createSpecialistHost, type RoleSource } from "../src/compose/specialists.ts";

const role = {
  role: "shopper",
  label: "Shopper",
  description: "Compares products.",
  skill: "specialist-shopper",
  source: "bundled" as const,
  modelClass: "primary" as const,
  maxMode: "balanced" as const,
  tools: ["web_search"],
  result: "items" as const,
  planFirst: true,
  budget: { tokens: 100_000, costUsd: 1, minutes: 20 },
  caps: { tokens: 500_000, costUsd: 5, minutes: 120, maxHours: 24 },
  approvals: ["new_origin" as const],
};

const automation = (specialist?: Automation["specialist"]): Automation => ({
  id: "aut_1",
  kind: "cron",
  title: "Weekly price check",
  schedule: "0 9 * * 1",
  timezone: "UTC",
  sessionTarget: "isolated",
  delivery: {},
  prompt: "Check the prices on my watchlist",
  scratch: null,
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  createdAt: "2026-10-19T12:00:00.000Z",
  updatedAt: "2026-10-19T12:00:00.000Z",
  ...(specialist === undefined ? {} : { specialist }),
});

const run = { id: "arun_1", automationId: "aut_1", taskId: null } as unknown as AutomationRun;

function setup() {
  const clock = new FakeClock();
  const ids = createIdGenerator({ prefix: "db" });
  const db = openDb(":memory:", {
    now: () => new Date(clock.now()).toISOString(),
    newId: () => ids.next(),
  });
  createThread(db, { id: "thr_auto", kind: "automation", sessionKey: "automation:aut_1" });
  const tasks = new SqliteTaskEngine({ db, clock });
  const roles: RoleSource = {
    specialistRoles: async () =>
      [{ role, defaultOn: true, body: "You are the shopper.", skill: { specialist: {} } }] as never,
  };
  const host = createSpecialistHost({
    db,
    tasks,
    broker: new FakePermissionBroker({ clock }),
    roles,
    models: { primary: "fake/primary" },
    now: () => clock.now(),
  });
  const plain: string[] = [];
  const inner: RunLauncher = {
    async launch(r) {
      plain.push(r.automation.id);
      return { result: Promise.resolve({ status: "done", summary: "plain" }) };
    },
  };
  const launcher = withAutomationSpecialists(inner, { db, tasks, host, now: () => clock.now() });
  return { tasks, launcher, plain };
}

const request = (a: Automation) => ({
  automation: a,
  run,
  threadId: "thr_auto",
  prompt: a.prompt,
  lightContext: false,
});

describe("automations as specialists (§4.10)", () => {
  it("runs as an unattended specialist job with no parent run and no plan step", async () => {
    const { tasks, launcher, plain } = setup();
    const handle = await launcher.launch(
      request(automation({ role: "shopper", budget: { tokens: 60_000 } })),
    );
    expect(plain).toEqual([]);
    const task = await tasks.get(handle.taskId as string);
    expect(task?.createdFrom).toBe("subagent");
    expect(tasks.getRecord(task?.id as string)?.runMode).toBe("unattended");
    expect(task?.specialist).toMatchObject({
      role: "shopper",
      parentThreadId: "thr_auto",
      parentRunId: null,
      rootRunId: null,
      planFirst: false,
      automation: { id: "aut_1", title: "Weekly price check" },
    });
    expect(task?.specialist?.budget.limit.tokens).toBe(60_000);
    expect(task?.goal).toContain("Check the prices on my watchlist");
    await tasks.cancel(task?.id as string, "test");
    expect((await handle.result).status).toBe("cancelled");
  });

  it("leaves other automations to the inner launcher", async () => {
    const { launcher, plain } = setup();
    const handle = await launcher.launch(request(automation()));
    expect(plain).toEqual(["aut_1"]);
    expect((await handle.result).summary).toBe("plain");
  });

  it("fails the run when the role is off", async () => {
    const { launcher } = setup();
    await expect(launcher.launch(request(automation({ role: "coder" })))).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});
