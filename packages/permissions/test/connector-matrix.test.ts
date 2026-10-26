import type { ApprovalKind, SideEffect } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { matrixFloor, matrixRule, type PolicyCall } from "../src/index.ts";
import { CTX, call, makeBroker } from "./helpers.ts";

/**
 * #747: Settings → Connectors' Allow / Ask / Deny per action group reaches the broker. A
 * first-party connector tool call carries its group as `connectorRule` (the connectors registry
 * stamps it); the owner's entry decides, under the hard floors.
 */

const MAIL = "apple-mail";

function connectorCall(
  tool: string,
  action: string,
  sideEffect: SideEffect,
  kind: ApprovalKind = "connector_action",
  extra: Partial<PolicyCall> = {},
): PolicyCall {
  return call(
    `mcp__${MAIL}__${tool}`,
    sideEffect,
    { kind: "account", value: MAIL },
    {
      kind,
      connectorRule: { id: MAIL, action },
      toolCallId: `tc_${tool}`,
      ...extra,
    },
  );
}

const organize = () => connectorCall("mail_set_flags", "mail.organize", "write");

function broker(matrix: Record<string, "allow" | "ask" | "deny">, id = MAIL) {
  return makeBroker({ policy: { connectors: { [id]: matrix } } });
}

describe("connector action matrix in the broker (#747)", () => {
  it("allow: no card, and the decision names the group's rule", async () => {
    const h = broker({ "mail.organize": "allow" });
    expect(await h.broker.decide(organize(), CTX)).toMatchObject({
      decision: "allow",
      rule: `connector:${MAIL}/mail.organize`,
    });
  });

  it("ask: a card from the matrix", async () => {
    const h = broker({ "mail.organize": "ask" });
    expect(await h.broker.decide(organize(), CTX)).toMatchObject({
      decision: "ask",
      rule: `connector:${MAIL}/mail.organize`,
      approvalKind: "connector_action",
    });
  });

  it("deny: refused, with a receipt naming the rule", async () => {
    const h = broker({ "mail.organize": "deny" });
    expect(await h.broker.decide(organize(), CTX)).toMatchObject({
      decision: "deny",
      rule: `connector:${MAIL}/mail.organize`,
    });
    const receipts = await h.broker.listReceipts({ toolCallId: "tc_mail_set_flags" });
    expect(receipts).toMatchObject([
      {
        kind: "mail.organize",
        outcome: "failed",
        taskId: CTX.taskId,
        payload: { rule: `connector:${MAIL}/mail.organize`, decision: "deny" },
      },
    ]);
    expect(receipts[0]?.summary).toContain("Refused");
  });

  it("no entry: the mode default, not the unknown-MCP-tier floor", async () => {
    const h = makeBroker();
    const d = await h.broker.decide(organize(), CTX);
    expect(d.decision).toBe("ask");
    expect(d.rule).toBe("mode:balanced/write");
  });

  it("an unknown-tier MCP server still asks, whatever its matrix says", async () => {
    const h = broker({ "mail.organize": "allow" });
    const d = await h.broker.decide(
      connectorCall("mail_set_flags", "mail.organize", "write", "connector_action", {
        meta: { mcpTier: "unknown" },
      }),
      CTX,
    );
    expect(d).toMatchObject({ decision: "ask", rule: "mcp:unknown_tier" });
  });

  describe("hard floors: an owner allow never silences", () => {
    it.each<[string, string, SideEffect, ApprovalKind]>([
      ["mail_send", "mail.send", "destructive", "send_email"],
      ["imessage_send", "messages.send", "write", "message_send"],
      ["reminders_delete", "reminders.delete", "destructive", "connector_action"],
      ["checkout", "shop.buy", "financial", "purchase"],
    ])("%s (%s, %s, %s)", async (tool, action, se, kind) => {
      const h = broker({ [action]: "allow" });
      const d = await h.broker.decide(connectorCall(tool, action, se, kind), CTX);
      expect(d.decision).toBe("ask");
      if (se !== "financial") expect(d.rule).toBe(`connector:${MAIL}/${action}:floor`);
    });

    it("but a deny still refuses them", async () => {
      const h = broker({ "mail.send": "deny" });
      const d = await h.broker.decide(
        connectorCall("mail_send", "mail.send", "destructive", "send_email"),
        CTX,
      );
      expect(d.decision).toBe("deny");
    });

    it("a tainted turn writing to a new target still asks", async () => {
      const h = broker({ "mail.organize": "allow" });
      const d = await h.broker.decide(organize(), { ...CTX, taint: true });
      expect(d).toMatchObject({ decision: "ask", rule: "taint:new_target" });
    });
  });

  describe("per-shortcut rules (config.shortcutRules → shortcuts.run/<id>)", () => {
    const run = (id: string) =>
      connectorCall("shortcuts_run", `shortcuts.run/${id}`, "destructive", "connector_action", {
        connectorRule: { id: "apple-shortcuts", action: `shortcuts.run/${id}` },
      });

    it("off denies that shortcut only", async () => {
      const h = broker({ "shortcuts.run/S1": "deny" }, "apple-shortcuts");
      expect(await h.broker.decide(run("S1"), CTX)).toMatchObject({
        decision: "deny",
        rule: "connector:apple-shortcuts/shortcuts.run/S1",
      });
      expect((await h.broker.decide(run("S2"), CTX)).decision).toBe("ask");
    });

    it("allow still asks: a run's side effect is unknown (destructive floor)", async () => {
      const h = broker({ "shortcuts.run/S1": "allow" }, "apple-shortcuts");
      expect(await h.broker.decide(run("S1"), CTX)).toMatchObject({
        decision: "ask",
        rule: "connector:apple-shortcuts/shortcuts.run/S1:floor",
      });
    });

    it("a sub-key never loosens its group", async () => {
      const h = broker({ "shortcuts.run": "deny", "shortcuts.run/S1": "allow" }, "apple-shortcuts");
      expect((await h.broker.decide(run("S1"), CTX)).decision).toBe("deny");
    });
  });

  it("an entry under the tool's own name (older policy files) still applies", async () => {
    const h = broker({ mail_set_flags: "deny" });
    expect((await h.broker.decide(organize(), CTX)).decision).toBe("deny");
  });

  it("matrixRule and matrixFloor", () => {
    expect(matrixRule(undefined, "a")).toBeUndefined();
    expect(matrixRule({ a: "allow", "a/x": "ask" }, "a/x")).toBe("ask");
    expect(matrixRule({ a: "ask", "a/x": "allow" }, "a/x")).toBe("ask");
    expect(matrixRule({ a: "allow" }, "a/x")).toBe("allow");
    expect(matrixRule({ a: "bogus" }, "a")).toBeUndefined();
    expect(matrixFloor("connector_action", "write")).toBeUndefined();
    expect(matrixFloor("calendar_write", "write")).toBeUndefined();
    expect(matrixFloor("send_email", "write")).toBe("sends always ask");
    expect(matrixFloor("credential_fill", "write")).toContain("credential_fill");
    expect(matrixFloor("connector_action", "destructive")).toContain("destructive");
  });
});
