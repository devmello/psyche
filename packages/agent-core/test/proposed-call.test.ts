import type { AgentEvent, StartTurnInput } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { endOf, harness, recorder, resultsIn, say, spec, turnInput, until } from "./harness.ts";

/** A widget button's proposed call (generative-ui-2026 §6.2, §7.3): same gate as a model's call. */
function startProposed(
  h: ReturnType<typeof harness>,
  proposed: NonNullable<StartTurnInput["proposedCall"]>,
  extra: Partial<StartTurnInput> = {},
) {
  const input: StartTurnInput = {
    ...turnInput("Run it (from widget)"),
    ownerWords: false,
    proposedCall: proposed,
    ...extra,
  };
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const e of h.loop.startTurn(input)) events.push(e);
    return events;
  })();
  return { events, done };
}

describe("proposed call", () => {
  it("meets the broker like a model's call: a write asks, nothing runs until approved, the model answers once", async () => {
    const exec = recorder();
    const h = harness({ script: [say("Sent.")] });
    h.loop.registry.register({ spec: spec("email.send", "write"), execute: exec.execute });
    const turn = startProposed(h, { tool: "email.send", input: { to: "a@b.c" } });
    await until(() => turn.events.some((e) => e.type === "approval_requested"), "approval card");
    expect(exec.seen).toHaveLength(0);
    // The model was not asked to choose the call: nothing has been sent to it yet.
    expect(h.provider.requests).toHaveLength(0);
    await h.broker.decideLatest("approve", h.clock);
    const events = await turn.done;
    expect(exec.seen).toEqual([expect.objectContaining({ params: { to: "a@b.c" } })]);
    expect(endOf(events).outcome).toBe("final");
    expect(h.provider.requests).toHaveLength(1);
    expect(h.broker.decisions).toHaveLength(1);
    expect(h.broker.decisions[0]?.call.tool).toBe("email.send");
    // The model sees the result as any tool result in its context.
    const results = [...resultsIn(h.provider.requests[0]).values()];
    expect(results).toHaveLength(1);
    expect(results[0]?.output).toEqual({ ok: true });
  });

  it("a denied call is blocked, never run", async () => {
    const exec = recorder();
    const h = harness({
      script: [say("I could not.")],
      policy: { byTool: { "email.send": "deny" } },
    });
    h.loop.registry.register({ spec: spec("email.send", "destructive"), execute: exec.execute });
    const events = await startProposed(h, { tool: "email.send", input: { to: "x@y.z" } }).done;
    expect(exec.seen).toHaveLength(0);
    expect(endOf(events).outcome).toBe("final");
    const result = [...resultsIn(h.provider.requests[0]).values()][0];
    expect(result?.isError).toBe(true);
  });

  it("an unknown tool is a failed call, not a crash", async () => {
    const h = harness({ script: [say("No such tool.")] });
    const events = await startProposed(h, { tool: "does.not.exist", input: {} }).done;
    expect(endOf(events).outcome).toBe("final");
    const result = [...resultsIn(h.provider.requests[0]).values()][0];
    expect(result?.isError).toBe(true);
  });

  it("carries the widget's taint into the decision, and its text is not the owner's words", async () => {
    const exec = recorder();
    const h = harness({ script: [say("Done.")], policy: { byTool: { "files.read": "allow" } } });
    h.loop.registry.register({ spec: spec("files.read", "read"), execute: exec.execute });
    const turn = startProposed(
      h,
      { tool: "files.read", input: { path: "/tmp/x" } },
      { taintSources: [{ sourceKind: "web", origin: "https://evil.example" }] },
    );
    await turn.done;
    const ctx = h.broker.decisions[0]?.ctx;
    expect(ctx?.taint).toBe(true);
    expect(ctx?.taintSources).toEqual([{ sourceKind: "web", origin: "https://evil.example" }]);
  });

  it("previewCall says what the broker would answer, without running or asking", async () => {
    const exec = recorder();
    const h = harness({ policy: { byTool: { "email.send": "ask", "files.read": "allow" } } });
    h.loop.registry.register({ spec: spec("email.send", "write"), execute: exec.execute });
    h.loop.registry.register({ spec: spec("files.read", "read"), execute: exec.execute });
    const ask = await h.loop.previewCall({
      threadId: "thr_1",
      tool: "email.send",
      input: {},
      permissionMode: "balanced",
      taintSources: [],
    });
    const allow = await h.loop.previewCall({
      threadId: "thr_1",
      tool: "files.read",
      input: {},
      permissionMode: "balanced",
      taintSources: [],
    });
    const none = await h.loop.previewCall({
      threadId: "thr_1",
      tool: "nope",
      input: {},
      permissionMode: "balanced",
      taintSources: [],
    });
    expect(ask.decision).toBe("ask");
    expect(allow.decision).toBe("allow");
    expect(none.decision).toBe("unavailable");
    expect(exec.seen).toHaveLength(0);
    expect(h.broker.issued).toHaveLength(0);
  });
});
