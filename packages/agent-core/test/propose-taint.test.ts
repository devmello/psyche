import { validateParams } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { proposalTaint } from "../src/builtins/automation.ts";
import { proposeAutomationTool, scheduleTool } from "../src/index.ts";

/** propose_automation from a tainted turn carries the turn's sources on the block. */

function propose(ctx: Record<string, unknown>) {
  const blocks: { proposal: Record<string, unknown> }[] = [];
  const tool = proposeAutomationTool({ timeZone: "UTC", newId: () => "abc123456" });
  const c = {
    threadId: "t1",
    turn: { emitBlock: (b: { proposal: Record<string, unknown> }) => blocks.push(b) },
    ...ctx,
  };
  const input = {
    title: "Daily news",
    notify: "notification",
    obstacles: [],
    runs: [
      {
        name: "Morning",
        kind: "cron",
        schedule: "0 8 * * *",
        humanSchedule: "Every day at 8:00 AM",
        prompt: "Summarise",
        steps: ["Read"],
        approvals: [],
      },
    ],
  };
  return { blocks, run: () => tool.run?.(input as never, c as never) };
}

describe("propose_automation taint", () => {
  it("a tainted turn puts its deduped sources on the proposal", async () => {
    const s = { sourceKind: "web.fetch", origin: "https://example.com/a" };
    const { blocks, run } = propose({ taint: true, taintSources: [s, { ...s }] });
    await run();
    expect(blocks[0]?.proposal).toMatchObject({
      tainted: true,
      taintSources: [{ sourceKind: "web.fetch" }],
    });
  });

  it("tainted with no recorded source still carries one", async () => {
    const { blocks, run } = propose({ taint: true });
    await run();
    expect(blocks[0]?.proposal.taintSources).toEqual([{ sourceKind: "turn" }]);
  });

  it("positive control: a clean turn's proposal carries no taint", async () => {
    const { blocks, run } = propose({ taint: false });
    await run();
    expect(blocks[0]?.proposal).not.toHaveProperty("tainted");
    expect(blocks[0]?.proposal).not.toHaveProperty("taintSources");
  });
});

describe("proposal taint fits the confirm schema and leaks no address", () => {
  it("a 400-char origin and 40 distinct sources: kinds only, capped, and the confirm params validate", async () => {
    const sources = [
      {
        sourceKind: "web.fetch",
        origin: `https://example.com/${"a".repeat(400)}`,
        sender: "x@y.z",
      },
      ...Array.from({ length: 40 }, (_, i) => ({ sourceKind: `k${i}`, origin: `/p/${i}` })),
      { sourceKind: "z".repeat(200) },
    ];
    const { blocks, run } = propose({ taint: true, taintSources: sources });
    await run();
    const proposal = blocks[0]?.proposal as { taintSources: Record<string, unknown>[] };
    expect(proposal.taintSources).toHaveLength(32);
    expect(proposal.taintSources.at(-1)).toEqual({ sourceKind: "more" });
    for (const s of proposal.taintSources) expect(Object.keys(s)).toEqual(["sourceKind"]);
    expect(JSON.stringify(proposal)).not.toContain("example.com");
    expect(JSON.stringify(proposal)).not.toContain("x@y.z");
    expect(() => validateParams("daily.workflows.confirm", { proposal })).not.toThrow();
  });

  it("kinds are cut to 80 characters and deduped", () => {
    const out = proposalTaint([{ sourceKind: "z".repeat(200) }, { sourceKind: "z".repeat(90) }]);
    expect(out).toEqual([{ sourceKind: "z".repeat(80) }]);
  });
});

describe("schedule tool and reserved markers", () => {
  const tool = (made: unknown[]) =>
    scheduleTool(
      {
        create: async (a: unknown) => {
          made.push(a);
          return { id: "a1", nextRunAt: null };
        },
      } as never,
      "UTC",
    );
  const params = (prompt: string) => ({
    title: "x",
    kind: "cron",
    schedule: "0 8 * * *",
    prompt,
  });

  it.each([
    "[psyche:feed-brief daily]\nmore",
    "  [PSYCHE:goal-checkin g]",
    "[psyche]",
    "@psyche/memory:dreaming",
    " @Psyche/teaching:weekly",
  ])("refuses %j", async (prompt) => {
    const made: unknown[] = [];
    await expect(
      tool(made).run?.(params(prompt) as never, { threadId: "t", taint: true } as never),
    ).rejects.toMatchObject({ code: "invalid_params" });
    expect(made).toHaveLength(0);
  });

  it("accepts an ordinary prompt, and one that only mentions the word", async () => {
    const made: unknown[] = [];
    const t = tool(made);
    await t.run?.(params("Summarise the news") as never, { threadId: "t" } as never);
    await t.run?.(params("Tell me about psyche updates") as never, { threadId: "t" } as never);
    expect(made).toHaveLength(2);
  });

  it("an unattended tainted run that calls schedule makes a tainted automation", async () => {
    const made: Record<string, unknown>[] = [];
    await tool(made as never).run?.(
      params("Summarise") as never,
      {
        threadId: "t",
        mode: "unattended",
        taint: true,
        taintSources: [{ sourceKind: "task" }],
      } as never,
    );
    expect(made[0]?.taintSources).toEqual([{ sourceKind: "task" }]);
  });
});
