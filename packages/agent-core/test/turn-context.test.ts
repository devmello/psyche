import { describe, expect, it } from "vitest";
import type { TurnContextInput, TurnContextProvider } from "../src/index.ts";
import { blocks, call, harness, recorder, runTurn, say, spec } from "./harness.ts";

/** E12 seam: context from the owner's own data, once per owner turn, untrusted, with a block. */

function provider(calls: TurnContextInput[], fail = false): TurnContextProvider {
  return {
    name: "other-chats",
    async provide(input) {
      calls.push(input);
      if (fail) throw new Error("index down");
      return {
        sections: [
          { title: "From your other chats", text: "- Launch plan: ship on Nov 3 with Maya." },
        ],
        block: {
          type: "related_threads",
          items: [
            {
              threadId: "thr_main",
              title: "Launch plan",
              snippet: "ship on Nov 3",
              lastMessageAt: null,
            },
          ],
        },
        source: { sourceKind: "other_chats", origin: "thr_main" },
      };
    },
  };
}

describe("turn context providers (E12)", () => {
  it("run once per owner turn: untrusted sections, a taint source and a reply block", async () => {
    const calls: TurnContextInput[] = [];
    const h = harness({
      script: [call("r1", "notes.list", {}), say("Nov 3, with Maya.")],
      loop: { contextProviders: [provider(calls)] },
    });
    h.loop.registry.register({ spec: spec("notes.list", "read"), execute: recorder().execute });
    const events = await runTurn(h, "when is the launch?");
    expect(calls.map((c) => c.text)).toEqual(["when is the launch?"]);
    for (const r of h.provider.requests) {
      expect(r.system).toContain('source="context:other-chats" provenance="untrusted"');
    }
    expect(h.broker.decisions[0]?.ctx.taintSources).toEqual([
      { sourceKind: "other_chats", origin: "thr_main" },
    ]);
    expect(blocks(events).filter((b) => b.type === "related_threads")).toHaveLength(1);
  });

  it("add nothing when they fail, and never run for a non-owner requester", async () => {
    const calls: TurnContextInput[] = [];
    const h = harness({
      script: [say("ok"), say("ok")],
      loop: { contextProviders: [provider(calls, true)] },
    });
    const events = await runTurn(h, "hi");
    expect(h.provider.requests[0]?.system ?? "").not.toContain("context:other-chats");
    expect(blocks(events).filter((b) => b.type === "related_threads")).toHaveLength(0);
    const quiet: TurnContextInput[] = [];
    const h2 = harness({ script: [say("ok")], loop: { contextProviders: [provider(quiet)] } });
    await runTurn(h2, "hello", {
      requester: { role: "designated", identityId: "id_sam", channel: "telegram", senderId: "42" },
    });
    expect(quiet).toEqual([]);
  });
});
