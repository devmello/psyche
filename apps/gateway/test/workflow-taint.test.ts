import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeAutomationTool } from "@psyche/agent-core";
import type { Automation, DailyWorkflowProposal, Task } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * A workflow proposal made from untrusted content, confirmed through the real Gateway: every run
 * it creates starts tainted, the clients see only the kinds, and a clean proposal stays clean.
 */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const proposal = (
  groupId: string,
  extra: Partial<DailyWorkflowProposal>,
): DailyWorkflowProposal => ({
  groupId,
  title: "News",
  timezone: "UTC",
  notify: "notification",
  obstacles: [],
  runs: ["Morning", "Evening"].map((name, i) => ({
    name,
    kind: "cron" as const,
    schedule: i === 0 ? "0 9 * * *" : "0 18 * * *",
    humanSchedule: name,
    prompt: `${name} run`,
    steps: ["Read"],
    approvals: [],
  })),
  ...extra,
});

describe("daily.workflows.confirm taint, end to end", () => {
  it("tainted proposal: every run is tainted; clean proposal: none is", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-workflow-taint-"));
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    const confirm = async (p: DailyWorkflowProposal) =>
      (
        await owner.call<{ automations: Automation[] }>(
          "daily.workflows.confirm",
          { proposal: p },
          ik(),
        )
      ).automations;

    const dirty = await confirm(
      proposal("news-dirty-01", {
        tainted: true,
        taintSources: [{ sourceKind: "web.fetch", origin: "https://example.com/a" }],
      }),
    );
    const dirtyNoSources = await confirm(proposal("news-dirty-02", { tainted: true }));
    const clean = await confirm(proposal("news-clean-01", {}));

    // Clients see only the kinds, never the origin or sender.
    for (const a of dirty) expect(a.taintSources).toEqual([{ sourceKind: "web.fetch" }]);
    for (const a of dirtyNoSources)
      expect(a.taintSources).toEqual([{ sourceKind: "workflow_proposal" }]);
    for (const a of clean) expect(a.taintSources).toBeUndefined();
    const listed = await owner.call<{ automations: Automation[] }>("automations.list", {});
    expect(JSON.stringify(listed)).not.toContain("example.com");

    // Run each one: the task it starts is tainted exactly when its automation is.
    const all = [...dirty, ...dirtyNoSources, ...clean];
    for (const a of all) await owner.call("automations.run", { automationId: a.id }, ik());
    const { tasks } = await owner.call<{ tasks: Task[] }>("tasks.list", {});
    const byGoal = (needle: string) => tasks.filter((t) => t.goal.includes(needle));
    expect(tasks.length).toBeGreaterThanOrEqual(all.length);
    for (const g of ["news-dirty-01", "news-dirty-02"]) {
      const ts = byGoal(g);
      expect(ts.length).toBe(2);
      for (const t of ts) expect(t.taint, g).toBe(true);
    }
    const cleanTasks = byGoal("news-clean-01");
    expect(cleanTasks.length).toBe(2);
    for (const t of cleanTasks) expect(t.taint).toBeFalsy();
    expect(byGoal("news-dirty-01")[0]?.taintSources).toEqual([
      { sourceKind: "web.fetch", origin: "https://example.com/a" },
    ]);
  }, 60_000);

  it("a proposal the real tool made from a long-origin, many-source turn confirms and runs tainted", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-workflow-taint-"));
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    const blocks: { proposal: DailyWorkflowProposal }[] = [];
    const tool = proposeAutomationTool({ timeZone: "UTC", newId: () => "long01" });
    const sources = [
      { sourceKind: "web.fetch", origin: `https://example.com/${"a".repeat(400)}` },
      ...Array.from({ length: 40 }, (_, i) => ({ sourceKind: `read_file${i}`, origin: `/f/${i}` })),
    ];
    await tool.run?.(
      {
        title: "News",
        notify: "notification",
        obstacles: [],
        runs: [
          {
            name: "Morning",
            kind: "cron",
            schedule: "0 9 * * *",
            humanSchedule: "Every day at 9:00 AM",
            prompt: "Summarise",
            steps: ["Read"],
            approvals: [],
          },
        ],
      } as never,
      {
        threadId: "t1",
        taint: true,
        taintSources: sources,
        turn: { emitBlock: (b: { proposal: DailyWorkflowProposal }) => blocks.push(b) },
      } as never,
    );
    const proposal = blocks[0]?.proposal as DailyWorkflowProposal;
    expect(JSON.stringify(proposal)).not.toContain("example.com");
    const { automations } = await owner.call<{ automations: Automation[] }>(
      "daily.workflows.confirm",
      { proposal },
      ik(),
    );
    expect(automations).toHaveLength(1);
    expect(automations[0]?.taintSources?.length).toBe(32);
    await owner.call("automations.run", { automationId: automations[0]?.id }, ik());
    const { tasks } = await owner.call<{ tasks: Task[] }>("tasks.list", {});
    const task = tasks.find((t) => t.goal.includes("long01"));
    expect(task?.taint).toBe(true);
  }, 60_000);
});
