import type { SideEffect } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import type { PolicyCall, PolicyContext } from "../src/index.ts";
import { approve, CTX, call, makeBroker } from "./helpers.ts";

/**
 * A call an MCP App's page asked for (generative-ui-2026 P9): the owner clicked Run app, but the
 * arguments are the page's. The loop marks it `initiator: "mcp_app"` with an `mcp_app` taint
 * source, and the broker's rules for the server decide it like any other call to that server.
 */

const APP_CTX: PolicyContext = {
  ...CTX,
  taint: true,
  taintSources: [{ sourceKind: "mcp_app", origin: "echo", toolCallId: "tc_1" }],
  initiator: "mcp_app",
  // What the loop sends for a proposed app call: no owner words, so the target is always new.
  newTarget: true,
};

const HASH = `sha256:${"d".repeat(64)}`;

function mcp(tool: string, sideEffect: SideEffect, toolCallId = `tc_${tool}`): PolicyCall {
  return call(
    `mcp__echo__${tool}`,
    sideEffect,
    { kind: "account", value: "mcp:echo" },
    {
      kind: "connector_action",
      toolCallId,
      grantKey: `mcp__echo__${tool}|mcp:echo:${tool}:${HASH}`,
      meta: { mcpServerId: "echo", mcpToolsListHash: HASH, mcpTier: "verified" },
    },
  );
}

describe("a call from an MCP App's page", () => {
  it("an ask row asks, and the card carries the taint", async () => {
    const h = makeBroker({ policy: { ask: ["mcp__echo__send"] } });
    const d = await h.broker.decide(mcp("send", "write"), APP_CTX);
    expect(d).toMatchObject({ decision: "ask", approvalKind: "connector_action" });
    const issued = await h.broker.requestApproval({
      kind: "connector_action",
      summary: "echo send",
      details: {},
      bindingHash: d.bindingHash as string,
      grantKey: d.grantKey as string,
      requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
      sideEffect: "write",
      surfaces: ["desktop"],
      taint: APP_CTX.taint,
      taintSources: APP_CTX.taintSources ?? [],
    });
    expect(issued.approval.taint).toBe(true);
    expect(issued.approval.taintSources).toEqual([
      { sourceKind: "mcp_app", origin: "echo", toolCallId: "tc_1" },
    ]);
  });

  it("a deny row refuses it, with and without the page's mark (positive control)", async () => {
    const h = makeBroker({ policy: { deny: ["mcp__echo__send"] } });
    expect((await h.broker.decide(mcp("send", "write"), APP_CTX)).decision).toBe("deny");
    expect((await h.broker.decide(mcp("send", "write"), CTX)).decision).toBe("deny");
  });

  it("an allow row for a read runs it with no card", async () => {
    const h = makeBroker({ policy: { allow: ["mcp__echo__lookup"] } });
    const d = await h.broker.decide(mcp("lookup", "read"), APP_CTX);
    expect(d.decision).toBe("allow");
  });

  it("a standing Always grant never approves a write the page asked for", async () => {
    const h = makeBroker();
    // Positive control: with the owner's own (untainted) request the grant works.
    await approve(h, mcp("send", "write"), CTX, "always");
    expect((await h.broker.decide(mcp("send", "write"), CTX)).decision).toBe("allow");
    // The same call asked for by the page asks again, with the loop's newTarget...
    expect((await h.broker.decide(mcp("send", "write"), APP_CTX)).decision).toBe("ask");
    // ...and also when the target is not new, where only the standing-grant rule can stop it.
    const known = { ...APP_CTX, newTarget: false };
    expect((await h.broker.decide(mcp("send", "write"), known)).decision).toBe("ask");
  });

  it("an app write offers a once-only card: no task, session or Always scope", async () => {
    const h = makeBroker({ policy: { ask: ["mcp__echo__send"] } });
    for (const ctx of [APP_CTX, { ...APP_CTX, newTarget: false }]) {
      const d = await h.broker.decide(mcp("send", "write"), ctx);
      expect(d.decision).toBe("ask");
      expect(d.scopesOffered).toEqual(["once"]);
    }
    // Positive control: the same write from the owner's own turn offers more than once.
    const own = await h.broker.decide(mcp("send", "write"), CTX);
    expect(own.scopesOffered?.length ?? 0).toBeGreaterThan(1);
  });

  it("an app read keeps its scopes, and a read Always grant still allows the next app read", async () => {
    const h = makeBroker();
    const first = await h.broker.decide(mcp("lookup", "read"), APP_CTX);
    expect(first.decision).toBe("ask");
    expect(first.scopesOffered).toContain("always");
    await approve(h, mcp("lookup", "read"), APP_CTX, "always");
    expect((await h.broker.decide(mcp("lookup", "read"), APP_CTX)).decision).toBe("allow");
  });

  it("a payment tool is still the payment rule: a page cannot ride an allow row past it", async () => {
    const h = makeBroker({ policy: { allow: ["mcp__echo__*"] } });
    const pay = call(
      "mcp__echo__submitOrder",
      "write",
      { kind: "account", value: "mcp:echo" },
      {
        kind: "connector_action",
        toolCallId: "tc_pay",
        meta: { mcpServerId: "echo", mcpToolsListHash: HASH, mcpTier: "verified" },
      },
    );
    const d = await h.broker.decide(pay, APP_CTX);
    expect(d.decision).not.toBe("allow");
  });
});
