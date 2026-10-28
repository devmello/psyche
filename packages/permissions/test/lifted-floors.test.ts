import type { ApprovalKind, SideEffect } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { floorClass, floorLifted, type PolicyCall } from "../src/index.ts";
import { approve, CTX, call, makeBroker } from "./helpers.ts";

/**
 * §3.12: the send / destructive / financial floors are on by default, and the owner lifts one per
 * connector action with a confirmed opt-in (`liftedFloors`), or per call class with a confirmed
 * Always allow on the card. Taint, manual mode, deny and authentication kinds are unchanged.
 */

const MAIL = "apple-notes";

function connectorCall(
  tool: string,
  action: string,
  sideEffect: SideEffect,
  kind: ApprovalKind = "connector_action",
): PolicyCall {
  return call(
    `mcp__${MAIL}__${tool}`,
    sideEffect,
    { kind: "account", value: MAIL },
    { kind, connectorRule: { id: MAIL, action }, toolCallId: `tc_${tool}` },
  );
}

const CASES: [string, string, SideEffect, ApprovalKind][] = [
  ["notes_delete", "notes.delete", "destructive", "connector_action"],
  ["mail_send", "mail.send", "write", "send_email"],
  ["imessage_send", "messages.send", "write", "message_send"],
  ["pay_invoice", "billing.pay", "financial", "connector_action"],
];

function broker(action: string, lifted: boolean) {
  return makeBroker({
    policy: {
      connectors: { [MAIL]: { [action]: "allow" } },
      ...(lifted ? { liftedFloors: { [MAIL]: [action] } } : {}),
    },
  });
}

describe("liftable floors (§3.12)", () => {
  it.each(CASES)("the confirmed override lifts the floor: %s", async (tool, action, se, kind) => {
    const h = broker(action, true);
    const d = await h.broker.decide(connectorCall(tool, action, se, kind), CTX);
    expect(d).toMatchObject({
      decision: "allow",
      rule: `connector:${MAIL}/${action}:override`,
      via: "matrix-override",
    });
    const [entry] = await h.audit.query({ kind: "tool_call.decided" });
    expect(entry?.data).toMatchObject({ decision: "allow", via: "matrix-override" });
  });

  it.each(CASES)(
    "a plain allow without the override still asks: %s",
    async (tool, action, se, kind) => {
      const h = broker(action, false);
      const d = await h.broker.decide(connectorCall(tool, action, se, kind), CTX);
      expect(d).toMatchObject({ decision: "ask", rule: `connector:${MAIL}/${action}:floor` });
      expect(d.via).toBeUndefined();
    },
  );

  it("an override with no allow does nothing; deny still refuses", async () => {
    const asks = makeBroker({
      policy: {
        connectors: { [MAIL]: { "notes.delete": "ask" } },
        liftedFloors: { [MAIL]: ["notes.delete"] },
      },
    });
    const c = connectorCall("notes_delete", "notes.delete", "destructive");
    expect((await asks.broker.decide(c, CTX)).decision).toBe("ask");
    const denies = makeBroker({
      policy: {
        connectors: { [MAIL]: { "notes.delete": "deny" } },
        liftedFloors: { [MAIL]: ["notes.delete"] },
      },
    });
    expect((await denies.broker.decide(c, CTX)).decision).toBe("deny");
  });

  it.each(CASES)(
    "taint asks, once only, despite the override: %s",
    async (tool, action, se, kind) => {
      const h = broker(action, true);
      const d = await h.broker.decide(connectorCall(tool, action, se, kind), {
        ...CTX,
        taint: true,
        newTarget: false,
      });
      expect(d.decision).toBe("ask");
      expect(d.rule).toMatch(/^taint:/);
      expect(d.scopesOffered).toEqual(["once"]);
    },
  );

  it.each(CASES)("manual mode asks despite the override: %s", async (tool, action, se, kind) => {
    const h = broker(action, true);
    const d = await h.broker.decide(connectorCall(tool, action, se, kind), {
      ...CTX,
      permissionMode: "manual",
    });
    expect(d.decision).toBe("ask");
    expect(d.scopesOffered).toEqual(["once"]);
  });

  it.each<[string, string, SideEffect, ApprovalKind]>([
    ["checkout", "shop.buy", "financial", "purchase"],
    ["fill", "vault.fill", "write", "credential_fill"],
    ["script", "scripts.run", "write", "apple_script"],
    ["pair", "devices.pair", "write", "pairing"],
  ])(
    "authentication and device-only kinds keep their floor: %s (%s)",
    async (tool, action, se, kind) => {
      expect(floorClass(kind, se)).toBeUndefined();
      const h = broker(action, true);
      const d = await h.broker.decide(connectorCall(tool, action, se, kind), CTX);
      expect(d.decision).not.toBe("allow");
      expect(d.via).toBeUndefined();
    },
  );

  it("a non-owner requester never uses the owner's override", async () => {
    const h = broker("notes.delete", true);
    const d = await h.broker.decide(connectorCall("notes_delete", "notes.delete", "destructive"), {
      ...CTX,
      requester: { role: "designated", identityId: "id_friend", senderId: "friend" },
    });
    expect(d.decision).not.toBe("allow");
  });

  it("a sub-key action is covered by its group's override", () => {
    expect(floorLifted(["shortcuts.run"], "shortcuts.run/S1")).toBe(true);
    expect(floorLifted(["shortcuts.run/S2"], "shortcuts.run/S1")).toBe(false);
    expect(floorLifted(undefined, "notes.delete")).toBe(false);
  });
});

describe("Always allow on a floored card (§3.4, §3.12)", () => {
  const del = () => connectorCall("notes_delete", "notes.delete", "destructive");

  it("a destructive card offers always; the grant lets the call through, then revoked asks", async () => {
    // The owner's plain allow (no override) floors the call; their Always grant lifts it.
    const h = broker("notes.delete", false);
    const first = await h.broker.decide(del(), CTX);
    expect(first.scopesOffered).toContain("always");
    const { approval } = await approve(h, del(), CTX, "always");
    expect(approval.scopeGranted).toBe("always");
    const [g] = await h.broker.listGrants();
    expect(g).toMatchObject({
      scope: "always",
      grantKey: first.grantKey,
      kind: "connector_action",
    });
    // Lifetime: the `always` default (90 days).
    expect(Date.parse(g?.expiresAt ?? "") - h.clock.now()).toBeGreaterThan(89 * 86_400_000);

    const later = await h.broker.decide(del(), { ...CTX, taskId: "task_2", runId: "run_2" });
    expect(later).toMatchObject({ decision: "allow", grantId: g?.id, via: "grant" });

    // Taint still asks, once only, with the grant present.
    const tainted = await h.broker.decide(del(), { ...CTX, taint: true, newTarget: false });
    expect(tainted).toMatchObject({ decision: "ask", rule: "taint:floor" });
    expect(tainted.scopesOffered).toEqual(["once"]);

    // Manual mode asks.
    const manual = await h.broker.decide(del(), { ...CTX, permissionMode: "manual" });
    expect(manual.decision).toBe("ask");

    await h.broker.revokeGrant(g?.id ?? "");
    const revoked = await h.broker.decide(del(), CTX);
    expect(revoked).toMatchObject({
      decision: "ask",
      rule: `connector:${MAIL}/notes.delete:floor`,
    });
  });

  it("a financial card offers once / always; a purchase card stays once", async () => {
    const h = makeBroker();
    const pay = await h.broker.decide(
      connectorCall("pay_invoice", "billing.pay", "financial"),
      CTX,
    );
    expect(pay.scopesOffered).toEqual(["once", "always"]);
    const buy = await h.broker.decide(
      connectorCall("checkout", "shop.buy", "financial", "purchase"),
      CTX,
    );
    expect(buy.scopesOffered).toEqual(["once"]);
  });

  it("a tainted floored card is requested with once only", async () => {
    const h = makeBroker();
    const d = await h.broker.decide(del(), { ...CTX, taint: true });
    expect(d.scopesOffered).toEqual(["once"]);
    const issued = await h.broker.requestApproval({
      kind: "connector_action",
      summary: "delete a note",
      details: {},
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "",
      requestedBy: { runId: CTX.runId, taskId: CTX.taskId ?? null, threadId: CTX.threadId },
      sideEffect: "destructive",
      surfaces: ["desktop"],
      taint: true,
      scopesOffered: ["once", "task", "always"],
    });
    expect(issued.approval.scopesOffered).toEqual(["once"]);
  });
});
