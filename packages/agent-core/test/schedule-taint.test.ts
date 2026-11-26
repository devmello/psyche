import { describe, expect, it } from "vitest";
import { scheduleTool } from "../src/index.ts";

/** The schedule tool carries the turn's taint into the stored automation (security §3.6). */

function made() {
  const out: Record<string, unknown>[] = [];
  const tool = scheduleTool(
    {
      create: async (a: Record<string, unknown>) => {
        out.push(a);
        return { id: "a1", nextRunAt: null };
      },
    } as never,
    "UTC",
  );
  return { out, tool };
}

const params = { title: "Daily news", kind: "cron", schedule: "0 8 * * *", prompt: "Summarise" };

describe("schedule tool taint", () => {
  it("a turn that read untrusted content stores its taint sources on the automation", async () => {
    const { out, tool } = made();
    const sources = [{ sourceKind: "web.fetch", origin: "https://example.com/a" }];
    await tool.run?.(
      params as never,
      {
        threadId: "t1",
        taint: true,
        taintSources: sources,
      } as never,
    );
    expect(out[0]?.taintSources).toEqual(sources);
    // A copy: later mutation of the turn's list cannot change the stored one.
    expect(out[0]?.taintSources).not.toBe(sources);
  });

  it("a tainted turn with no recorded source still stores a taint", async () => {
    const { out, tool } = made();
    await tool.run?.(params as never, { threadId: "t1", taint: true } as never);
    expect(out[0]?.taintSources).toEqual([{ sourceKind: "turn" }]);
  });

  it("positive control: a clean turn stores no taint", async () => {
    const { out, tool } = made();
    await tool.run?.(params as never, { threadId: "t1", taint: false } as never);
    expect(out[0]).not.toHaveProperty("taintSources");
  });
});
