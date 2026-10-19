import { AuditFrictionResult } from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { createPermissionHandlers, frictionMetrics, ruleFamily } from "../src/index.ts";
import { approve, CTX, call, DEVICE, makeBroker, origin } from "./helpers.ts";

/** Approval-friction metrics from the audit log (S05 M2). */
describe("friction metrics", () => {
  async function scenario() {
    const h = makeBroker();
    // 1: asked, approved always after 5 s; then twice allowed by the grant.
    const cal = call("calendar.create", "write", origin("https://calendar.example.com"));
    const d = await h.broker.decide(cal, CTX);
    const issued = await h.broker.requestApproval({
      kind: d.approvalKind ?? "calendar_write",
      summary: "event",
      details: {},
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "",
      requestedBy: { runId: CTX.runId, taskId: CTX.taskId ?? null, threadId: CTX.threadId },
      sideEffect: "write",
      surfaces: ["desktop"],
      taint: false,
    });
    h.clock.advance(5_000);
    await h.broker.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens.desktop ?? "",
      decision: "approve",
      scope: "always",
      decidedBy: DEVICE,
    });
    await h.broker.decide(cal, CTX);
    await h.broker.decide(cal, CTX);
    // 2: a destructive send approved once.
    const send = call("messages.send", "destructive", { kind: "recipient", value: "bob" });
    const { approval } = await approve(h, send, { ...CTX, runId: "run_2" }, "once");
    expect(approval.status).toBe("approved");
    // 3: a card left to expire.
    const d3 = await h.broker.decide(
      call("drive.share", "write", origin("https://drive.example.com")),
      CTX,
    );
    await h.broker.requestApproval({
      kind: d3.approvalKind ?? "connector_action",
      summary: "share",
      details: {},
      bindingHash: d3.bindingHash ?? "",
      grantKey: d3.grantKey ?? "",
      requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
      sideEffect: "write",
      surfaces: ["desktop"],
      taint: false,
    });
    h.clock.advance(31 * 60_000);
    await h.broker.list();
    // 4: a denied call (plan mode).
    await h.broker.decide(cal, { ...CTX, permissionMode: "plan" });
    await new Promise((r) => setImmediate(r));
    return h;
  }

  it("counts asks, answers, expiries, grant savings and latency", async () => {
    const h = await scenario();
    const r = frictionMetrics(await h.audit.query());
    expect(r.decisions).toBe(6);
    expect(r.asks).toBe(3);
    expect(r.askRate).toBeCloseTo(0.5);
    expect(r.allowedByGrant).toBe(2);
    expect(r.grantsCreated).toEqual({ always: 1 });
    expect(r.answerRate).toBeCloseTo(2 / 3);
    expect(r.approveRate).toBe(1);
    expect(r.p90AnswerMs).toBeGreaterThanOrEqual(5_000);
    const cal = r.byKind.find((k) => k.kind === "calendar_write");
    expect(cal).toMatchObject({ decisions: 4, asks: 1, allows: 2, denies: 1, approved: 1 });
    expect(r.byKind.find((k) => k.kind === "connector_action")).toMatchObject({ expired: 1 });
    expect(r.topAskRules[0]).toMatchObject({ rule: "mode:balanced/write" });
    expect(r.byMode.plan).toEqual({ decisions: 1, asks: 0 });
    // The wire shape the Gateway serves (protocol `audit.friction`).
    expect([...Value.Errors(AuditFrictionResult, r)]).toEqual([]);
  });

  it("is served as audit.friction to operator.read devices", async () => {
    const h = await scenario();
    const api = createPermissionHandlers(h.broker, h.audit);
    const r = await api["audit.friction"](
      {},
      { deviceId: "dev_mac", scopes: ["operator.read"], surface: "desktop" },
    );
    expect(r.asks).toBe(3);
    await expect(
      api["audit.friction"]({}, { deviceId: "dev_x", scopes: [], surface: "desktop" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("never reads arguments: the report has no params, bodies or targets", async () => {
    const h = makeBroker();
    await h.broker.decide(
      call(
        "email.send",
        "destructive",
        { kind: "recipient", value: "secret-person@example.org" },
        { params: { body: "private" } },
      ),
      CTX,
    );
    const text = JSON.stringify(frictionMetrics(await h.audit.query()));
    expect(text).not.toContain("secret-person");
    expect(text).not.toContain("private");
  });

  it("groups rules into families", () => {
    expect(ruleFamily("mode:balanced/write")).toBe("mode:balanced/write");
    expect(ruleFamily("mode:balanced/read:new_source")).toBe("mode:balanced/read");
    expect(ruleFamily("policy:ask:mcp__github__*")).toBe("policy:ask");
    expect(ruleFamily("taint:new_target")).toBe("taint:new_target");
    expect(ruleFamily("grant:grt_1")).toBe("grant");
  });
});
