import { describe, expect, it } from "vitest";
import type { HarnessAction, HarnessGateResult, HarnessPlugin } from "../src/index.ts";
import { blocks, call, endOf, harness, resultsIn, runTurn, say, start, until } from "./harness.ts";

/** A scripted coding harness: asks Psyche about each action, runs the allowed ones. */
function fakeHarness(actions: HarnessAction[], id = "claude-code") {
  const gated: HarnessGateResult[] = [];
  const plugin: HarnessPlugin = {
    id,
    name: "Fake Claude Code",
    available: async () => true,
    run: async (ctx) => {
      ctx.progress("starting");
      for (const action of actions) {
        const r = await ctx.gate(action);
        gated.push(r);
        if (r.allowed) await ctx.actionDone(r.actionId, "ok");
      }
      return {
        report: `ran ${gated.filter((g) => g.allowed).length} actions in ${ctx.cwd}`,
        outcome: "completed",
        sessionId: "sess_1",
      };
    },
  };
  return { plugin, gated };
}

const edit: HarnessAction = {
  tool: "Edit",
  input: { file: "/repo/src/a.ts" },
  sideEffect: "write",
  targetKind: "path",
  target: { kind: "path", value: "/repo/src/a.ts" },
  summary: "Edit src/a.ts",
};
const rm: HarnessAction = {
  tool: "Bash",
  input: { command: "rm -rf build" },
  sideEffect: "destructive",
  targetKind: "command",
  target: { kind: "command", value: "rm -rf build" },
  summary: "Run rm -rf build",
};
const delegate = (harnessId = "claude-code") =>
  call("h1", "harness.delegate", { harness: harnessId, cwd: "/repo", brief: "fix the build" });

describe("harness plugins (C10)", () => {
  it("offers harness.delegate only once a harness is installed, never in plan mode", async () => {
    const h = harness({ script: [say("a"), say("b"), say("c")] });
    await runTurn(h, "hi");
    expect(h.provider.requests[0]?.tools?.map((t) => t.name)).not.toContain("harness.delegate");
    h.loop.harnesses.register(fakeHarness([]).plugin);
    await runTurn(h, "hi", { threadId: "thr_2" });
    expect(h.provider.requests[1]?.tools?.map((t) => t.name)).toContain("harness.delegate");
    await runTurn(h, "hi", { threadId: "thr_3", permissionMode: "plan" });
    expect(h.provider.requests[2]?.tools?.map((t) => t.name)).not.toContain("harness.delegate");
  });

  it("every harness action passes the broker with the same approval cards, and gets a receipt", async () => {
    const fake = fakeHarness([edit, rm]);
    const h = harness({
      script: [delegate(), say("The build is fixed.")],
      policy: { byTool: { "harness.delegate": "allow" }, bySideEffect: { write: "allow" } },
    });
    h.loop.harnesses.register(fake.plugin);
    const turn = start(h, "fix the build in /repo, you may edit /repo/src/a.ts");
    await until(() => h.broker.issued.length === 1, "destructive action approval");
    const card = h.broker.issued[0]?.approval;
    expect(card).toMatchObject({
      sideEffect: "destructive",
      taint: true,
      target: { value: "rm -rf build" },
    });
    expect(card?.requestedBy.toolCallId).toBe("h1:2");
    await h.broker.decideLatest("approve", h.clock);
    const events = await turn.done;
    expect(endOf(events).outcome).toBe("final");
    expect(fake.gated.map((g) => g.allowed)).toEqual([true, true]);
    const tools = h.broker.decisions.map((d) => d.call.tool);
    expect(tools).toEqual([
      "harness.delegate",
      "harness__claude-code__Edit",
      "harness__claude-code__Bash",
    ]);
    expect(h.broker.decisions[1]?.ctx.taint).toBe(true);
    expect(await h.broker.listReceipts({ toolCallId: "h1:2" })).toHaveLength(1);
    expect(blocks(events).filter((b) => b.type === "receipt")).toHaveLength(3);
    const result = resultsIn(h.provider.requests[1]).get("h1");
    expect(result).toMatchObject({
      provenance: "untrusted",
      output: { outcome: "completed", sessionId: "sess_1" },
    });
  });

  it("a denied action is reported back to the harness and never runs", async () => {
    const fake = fakeHarness([rm]);
    const h = harness({
      script: [delegate(), say("It could not delete build/.")],
      policy: { byTool: { "harness.delegate": "allow", "harness__claude-code__Bash": "deny" } },
    });
    h.loop.harnesses.register(fake.plugin);
    await runTurn(h, "clean up");
    expect(fake.gated[0]).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("denied"),
    });
    expect(await h.broker.listReceipts({ toolCallId: "h1:1" })).toHaveLength(0);
  });

  it("an unknown harness is an error the model sees", async () => {
    const h = harness({
      script: [delegate("codex"), say("ok")],
      policy: { byTool: { "harness.delegate": "allow" } },
    });
    h.loop.harnesses.register(fakeHarness([]).plugin);
    await runTurn(h, "go");
    expect(JSON.stringify(resultsIn(h.provider.requests[1]).get("h1")?.output)).toContain(
      "no harness codex",
    );
  });

  it("cancelling the run while an action waits for approval stops the session", async () => {
    const fake = fakeHarness([rm]);
    const h = harness({
      script: [delegate()],
      policy: { byTool: { "harness.delegate": "allow" } },
    });
    h.loop.harnesses.register(fake.plugin);
    const turn = start(h, "go");
    await until(() => h.broker.issued.length === 1, "approval");
    await h.loop.cancel(turn.runId);
    const events = await turn.done;
    expect(endOf(events).outcome).toBe("cancelled");
    expect(fake.gated).toHaveLength(0);
  });

  it("rejects bad or duplicate harness ids", () => {
    const h = harness();
    h.loop.harnesses.register(fakeHarness([]).plugin);
    expect(() => h.loop.harnesses.register(fakeHarness([]).plugin)).toThrow(/already/);
    expect(() => h.loop.harnesses.register(fakeHarness([], "Bad Id").plugin)).toThrow(/invalid/);
  });
});
