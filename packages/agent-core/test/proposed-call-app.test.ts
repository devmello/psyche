import type { AgentEvent, StartTurnInput } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { endOf, harness, recorder, say, spec, turnInput, until } from "./harness.ts";

/** An MCP App panel's call (`only` + `onResult`): the owner-initiated, app-controlled path. */
function startApp(
  h: ReturnType<typeof harness>,
  proposed: NonNullable<StartTurnInput["proposedCall"]>,
  extra: Partial<StartTurnInput> = {},
) {
  const input: StartTurnInput = {
    ...turnInput("Run mcp__echo__send (from app)"),
    ownerWords: false,
    proposedCall: proposed,
    taintSources: [{ sourceKind: "mcp_app", origin: "echo", toolCallId: "tc_1" }],
    ...extra,
  };
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const e of h.loop.startTurn(input)) events.push(e);
    return events;
  })();
  return { events, done };
}

type Seen = { isError: boolean; output: unknown }[];

const appCall = (
  tool: string,
  seen: Seen,
  input: Record<string, unknown> = { to: "a@b.c" },
): NonNullable<StartTurnInput["proposedCall"]> => ({
  tool,
  input,
  only: true,
  initiator: "mcp_app",
  onResult: (r) => seen.push(r),
});

describe("proposed call for an MCP App panel", () => {
  it("an ask row opens a card with the app's taint, runs nothing until approved, and never calls the model", async () => {
    const exec = recorder();
    const h = harness({ script: [say("never sent")] });
    h.loop.registry.register({ spec: spec("mcp__echo__send", "write"), execute: exec.execute });
    const seen: Seen = [];
    const turn = startApp(h, appCall("mcp__echo__send", seen));
    await until(() => turn.events.some((e) => e.type === "approval_requested"), "approval card");
    expect(exec.seen).toHaveLength(0);
    expect(seen).toHaveLength(0);
    expect(h.broker.decisions[0]?.ctx).toMatchObject({
      taint: true,
      initiator: "mcp_app",
      taintSources: [{ sourceKind: "mcp_app", origin: "echo", toolCallId: "tc_1" }],
    });
    await h.broker.decideLatest("approve", h.clock);
    const events = await turn.done;
    expect(exec.seen).toEqual([expect.objectContaining({ params: { to: "a@b.c" } })]);
    expect(seen).toEqual([{ isError: false, output: { ok: true } }]);
    expect(endOf(events).outcome).toBe("final");
    // The result went to the panel: the model was never asked to answer from it.
    expect(h.provider.requests).toHaveLength(0);
  });

  it("a deny row refuses the call: nothing runs, the panel hears the refusal, no model call", async () => {
    const exec = recorder();
    const h = harness({
      script: [say("never sent")],
      policy: { byTool: { mcp__echo__send: "deny" } },
    });
    h.loop.registry.register({ spec: spec("mcp__echo__send", "write"), execute: exec.execute });
    const seen: Seen = [];
    const events = await startApp(h, appCall("mcp__echo__send", seen)).done;
    expect(exec.seen).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.isError).toBe(true);
    expect(endOf(events).outcome).toBe("final");
    expect(h.provider.requests).toHaveLength(0);
  });

  it("an allow row runs the tool and hands the panel its result", async () => {
    const exec = recorder();
    const h = harness({
      script: [say("never sent")],
      policy: { byTool: { mcp__echo__read: "allow" } },
    });
    h.loop.registry.register({ spec: spec("mcp__echo__read", "read"), execute: exec.execute });
    const seen: Seen = [];
    const events = await startApp(h, appCall("mcp__echo__read", seen, { id: 7 })).done;
    expect(exec.seen).toEqual([expect.objectContaining({ params: { id: 7 } })]);
    expect(seen).toEqual([{ isError: false, output: { ok: true } }]);
    expect(h.broker.decisions[0]?.ctx.initiator).toBe("mcp_app");
    expect(endOf(events).outcome).toBe("final");
    expect(h.provider.requests).toHaveLength(0);
  });

  it("a tool the loop does not have is an error result for the panel, not a crash", async () => {
    const h = harness({ script: [say("never sent")] });
    const seen: Seen = [];
    await startApp(h, appCall("mcp__echo__ghost", seen)).done;
    expect(seen).toHaveLength(1);
    expect(seen[0]?.isError).toBe(true);
  });

  it("without `only` the model still answers (a widget's proposal is unchanged)", async () => {
    const exec = recorder();
    const h = harness({ script: [say("Done.")], policy: { byTool: { "files.read": "allow" } } });
    h.loop.registry.register({ spec: spec("files.read", "read"), execute: exec.execute });
    await startApp(h, { tool: "files.read", input: {} }, { taintSources: [] }).done;
    expect(h.provider.requests).toHaveLength(1);
    expect(h.broker.decisions[0]?.ctx.initiator).toBeUndefined();
  });
});
