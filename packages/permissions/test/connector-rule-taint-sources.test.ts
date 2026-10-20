import { describe, expect, it } from "vitest";
import { CTX, call, makeBroker, recipient } from "./helpers.ts";

/** #71: the connector matrix key and the taint sources travel on the contract types. */
describe("ToolCallIntent.connectorRule and ApprovalRequest.taintSources (#71)", () => {
  it("applies the connector matrix from `connectorRule` without executor meta", async () => {
    const h = makeBroker({
      policy: { connectors: { google: { "gmail.send": "deny", "drafts.create": "allow" } } },
    });
    const send = call("gmail_send", "write", recipient("a@example.org"), {
      connectorRule: { id: "google", action: "gmail.send" },
    });
    const denied = await h.broker.decide(send, CTX);
    expect(denied).toMatchObject({ decision: "deny", rule: "connector:google/gmail.send" });
    const draft = call("gmail_draft", "write", recipient("a@example.org"), {
      connectorRule: { id: "google", action: "drafts.create" },
    });
    expect((await h.broker.decide(draft, CTX)).decision).toBe("allow");
  });

  it("puts the structured taint sources on a tainted request", async () => {
    const h = makeBroker();
    const ctx = {
      ...CTX,
      taint: true,
      taintSources: [{ sourceKind: "email", sender: "billing@vendor.example", toolCallId: "c1" }],
    };
    const c = call("calendar.create", "write", recipient("a@example.org"));
    const d = await h.broker.decide(c, ctx);
    const issued = await h.broker.requestApproval({
      kind: d.approvalKind ?? "connector_action",
      summary: "create",
      details: { tool: c.tool },
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "",
      requestedBy: { runId: CTX.runId, taskId: CTX.taskId ?? null, threadId: CTX.threadId },
      sideEffect: c.sideEffect,
      surfaces: ["desktop"],
      taint: true,
      context: ctx,
    });
    expect(issued.approval.taintSources).toEqual([
      { sourceKind: "email", sender: "billing@vendor.example", toolCallId: "c1" },
    ]);
    expect(issued.approval.details.taintSources).toEqual(["email:billing@vendor.example"]);
  });
});
