import { FakeClock, FakeMemoryStore } from "@psyche/testing";
import { describe, expect, it, vi } from "vitest";
import { forgetTool } from "../src/builtins/forget.ts";
import { memoryTool } from "../src/builtins/services.ts";
import type { ToolRunContext } from "../src/registry.ts";

const ctx = (over: Partial<ToolRunContext> = {}): ToolRunContext =>
  ({
    callId: "c1",
    threadId: "t1",
    runId: "r1",
    taint: false,
    permissionMode: "ask",
    mode: "normal",
    approvalId: "apr_1",
    ...over,
  }) as ToolRunContext;

const USER = [
  "# About the owner",
  "",
  "## Preferences",
  "",
  "- Prefers tabs over spaces in code <!--lf_abc123def 2026-11-20 thread:t0 preference-->",
  "- Likes tea <!--lf_zzz999aaa 2026-11-20 thread:t0 preference-->",
  "",
  "## Learned (dated; from your chats)",
  "",
  "- 2026-11-21 [lf_qqq111www thread:t0 fact] Drives a red car",
  "",
].join("\n");

function setup() {
  const memory = new FakeMemoryStore({ clock: new FakeClock(), files: { "USER.md": USER } });
  const tool = memoryTool(memory, { clock: new FakeClock(), timeZone: "UTC" });
  return { memory, tool };
}

describe("memory str_replace matches what the model sees (QA item 3)", () => {
  it("applies an approved edit whose old_str omits the hidden lf tag", async () => {
    const { memory, tool } = setup();
    await tool.run(
      {
        command: "str_replace",
        path: "USER.md",
        old_str: "- Prefers tabs over spaces in code\n",
        new_str: "",
      },
      ctx(),
    );
    const after = (await memory.readFile("USER.md"))?.content ?? "";
    expect(after).not.toContain("tabs");
    expect(after).toContain("- Likes tea <!--lf_zzz999aaa");
  });

  it("matches a learned line shown as `- date text`", async () => {
    const { memory, tool } = setup();
    await tool.run(
      {
        command: "str_replace",
        path: "USER.md",
        old_str: "- 2026-11-21 Drives a red car",
        new_str: "- 2026-11-21 Drives a blue car",
      },
      ctx(),
    );
    const after = (await memory.readFile("USER.md"))?.content ?? "";
    expect(after).toContain("Drives a blue car");
    expect(after).not.toContain("red car");
  });

  it("still fails when nothing matches, or when the text is ambiguous", async () => {
    const { tool } = setup();
    await expect(
      tool.run(
        { command: "str_replace", path: "USER.md", old_str: "- Likes coffee", new_str: "x" },
        ctx(),
      ),
    ).rejects.toThrow(/found 0/);
    await expect(
      tool.run({ command: "str_replace", path: "USER.md", old_str: "- ", new_str: "x" }, ctx()),
    ).rejects.toThrow(/found/);
  });

  it("an exact match still wins and leaves tags alone", async () => {
    const { memory, tool } = setup();
    await tool.run(
      { command: "str_replace", path: "USER.md", old_str: "Likes tea", new_str: "Likes tea a lot" },
      ctx(),
    );
    expect((await memory.readFile("USER.md"))?.content).toContain(
      "- Likes tea a lot <!--lf_zzz999aaa",
    );
  });
});

describe("memory_forget tool (QA item 4)", () => {
  const forgetResult = { retractedClaimIds: [], removedChunkIds: ["a"], files: ["USER.md"] };

  it("forgets the subject through the store's forget path", async () => {
    const forget = vi.fn(async () => forgetResult);
    const tool = forgetTool({ forget } as never);
    const r = await tool.run({ subject: "tabs over spaces" }, ctx());
    expect(forget).toHaveBeenCalledWith("tabs over spaces", { dryRun: false });
    expect(JSON.stringify(r.output)).toContain("USER.md");
  });

  it("previews without removing on dry_run, and says it only previewed", async () => {
    const forget = vi.fn(async () => forgetResult);
    const tool = forgetTool({ forget } as never);
    const r = await tool.run({ subject: "tabs over spaces", dry_run: true }, ctx());
    expect(forget).toHaveBeenCalledWith("tabs over spaces", { dryRun: true });
    expect(JSON.stringify(r.output)).toMatch(/would/i);
  });

  it("is a destructive call bound to the subject; a dry run needs no card", () => {
    const tool = forgetTool({ forget: vi.fn() } as never);
    const real = tool.describeCall?.({ subject: "Tabs  over spaces" });
    expect(real?.sideEffect).toBe("destructive");
    expect(real?.bindingFields).toEqual({ subject: "tabs over spaces" });
    expect(tool.describeCall?.({ subject: "x y z", dry_run: true })?.sideEffect).toBe("none");
  });

  it("refuses after untrusted content and for someone else's turn", async () => {
    const forget = vi.fn();
    const tool = forgetTool({ forget } as never);
    await expect(tool.run({ subject: "tabs over spaces" }, ctx({ taint: true }))).rejects.toThrow();
    await expect(
      tool.run({ subject: "tabs over spaces" }, ctx({ requester: { kind: "mcp" } as never })),
    ).rejects.toThrow();
    expect(forget).not.toHaveBeenCalled();
  });

  it("reports a failed forget instead of claiming success", async () => {
    const forget = vi.fn(async () => {
      throw new Error("boom");
    });
    const tool = forgetTool({ forget } as never);
    await expect(tool.run({ subject: "tabs over spaces" }, ctx())).rejects.toThrow("boom");
  });
});
