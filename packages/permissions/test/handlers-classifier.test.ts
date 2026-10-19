import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  type ActionClassifier,
  type ClassifierInput,
  classifyFailClosed,
  createPermissionHandlers,
  ModelClassifier,
  parseClassifierOutput,
  RulesClassifier,
} from "../src/index.ts";
import { CTX, call, makeBroker, memoryDb, sqliteBroker } from "./helpers.ts";

const input: ClassifierInput = {
  ownerMessages: ["add the dentist appointment"],
  task: { goalTainted: false },
  tool: "calendar.create",
  sideEffect: "write",
  argMeta: {},
  taint: { tainted: false, sourceKinds: [], origins: [] },
  sensitiveTarget: false,
};

describe("classifier (security §3.8)", () => {
  it("rules classifier: routine only for untainted writes aligned with an owner request", async () => {
    const c = new RulesClassifier();
    expect((await c.classify(input)).label).toBe("routine");
    expect(
      (
        await c.classify({
          ...input,
          taint: { tainted: true, sourceKinds: ["browser"], origins: [] },
        })
      ).label,
    ).toBe("sensitive");
    expect((await c.classify({ ...input, ownerMessages: [] })).label).toBe("sensitive");
    expect((await c.classify({ ...input, tool: "drive.share" })).label).toBe("sensitive");
    expect((await c.classify({ ...input, sideEffect: "financial" })).label).toBe("prohibited");
  });

  it("fails closed on errors, timeouts and malformed output", async () => {
    const throws: ActionClassifier = {
      id: "x",
      classify: async () => Promise.reject(new Error("down")),
    };
    expect((await classifyFailClosed(throws, input)).label).toBe("sensitive");
    const hangs: ActionClassifier = { id: "h", classify: () => new Promise(() => undefined) };
    expect(await classifyFailClosed(hangs, input, 20)).toMatchObject({
      label: "sensitive",
      reason: expect.stringContaining("timed out"),
    });
    const bogus: ActionClassifier = {
      id: "b",
      classify: async () => ({ label: "yes" as never, reason: "" }),
    };
    expect((await classifyFailClosed(bogus, input)).label).toBe("sensitive");
    expect(parseClassifierOutput("sure!").label).toBe("sensitive");
    expect(parseClassifierOutput('{"label":"routine","confidence":0.4}').label).toBe("sensitive");
    expect(parseClassifierOutput('{"label":"routine","confidence":0.95,"reason":"ok"}').label).toBe(
      "routine",
    );
  });

  it("model classifier sends only metadata and parses the label", async () => {
    const provider = FakeModelProvider.script([
      [
        { type: "text_delta", text: '{"label":"routine","confidence":0.9,"reason":"asked"}' },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const c = new ModelClassifier(provider, "fake/utility");
    expect((await c.classify(input, new AbortController().signal)).label).toBe("routine");
    const sent = JSON.stringify(provider.requests[0]);
    expect(sent).toContain("calendar.create");
    expect(sent).not.toContain("tool_result");
  });
});

describe("API handlers", () => {
  const desktop = {
    deviceId: "dev_mac",
    scopes: ["operator.read", "operator.approvals", "operator.admin"] as const,
    surface: "desktop",
  };

  it("answers with the connection's identity, never one from params", async () => {
    const h = makeBroker();
    const api = createPermissionHandlers(h.broker, h.audit);
    const d = await h.broker.decide(call("calendar.create", "write"), CTX);
    const issued = await h.broker.requestApproval({
      kind: d.approvalKind ?? "calendar_write",
      summary: "x",
      details: {},
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "",
      requestedBy: { runId: CTX.runId, taskId: CTX.taskId ?? null, threadId: CTX.threadId },
      sideEffect: "write",
      surfaces: ["desktop"],
      taint: false,
    });
    expect((await api["approvals.list"]({}, desktop)).approvals).toHaveLength(1);
    h.clock.advance(500);
    await expect(
      api["approvals.answer"]({ approvalId: issued.approval.id, decision: "approve" }, desktop),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      api["approvals.answer"](
        {
          approvalId: issued.approval.id,
          answerToken: issued.answerTokens.desktop,
          decision: "approve",
        },
        { ...desktop, scopes: ["operator.read"] },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const res = await api["approvals.answer"](
      {
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop,
        decision: "approve",
        scope: "always",
        decidedBy: { deviceId: "dev_forged" },
      },
      desktop,
    );
    expect(res.approval.status).toBe("approved");
    expect(res.approval.decidedBy).toEqual({ deviceId: "dev_mac", surface: "desktop" });
    expect(res.grant?.scope).toBe("always");
    expect((await api["grants.list"]({}, desktop)).grants).toHaveLength(1);
    await expect(
      api["grants.revoke"]({ grantId: res.grant?.id }, { ...desktop, scopes: ["operator.read"] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      (await api["grants.revoke"]({ grantId: res.grant?.id }, desktop)).grant.revokedAt,
    ).toBeTypeOf("string");
    const entries = (await api["audit.list"]({ kindPrefix: "approval." }, desktop)).entries;
    expect(entries.map((e) => e.kind)).toEqual(["approval.created", "approval.decided"]);
    expect(await api["audit.verify"]({}, desktop)).toMatchObject({ ok: true });
    expect((await api["audit.export"]({}, desktop)).data.split("\n").length).toBeGreaterThan(3);
  });

  it("node-role connections are refused", async () => {
    const h = makeBroker();
    const api = createPermissionHandlers(h.broker, h.audit);
    await expect(api["approvals.list"]({}, { ...desktop, role: "node" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("receipts on SQLite", () => {
  it("records, redacts, finds by task / tool call and reconciles uncertain outcomes", async () => {
    const clock = new FakeClock();
    const broker = sqliteBroker(memoryDb(), clock);
    const r = await broker.recordReceipt({
      kind: "send_email",
      outcome: "uncertain",
      summary: "Sent to alice",
      taskId: "task_1",
      toolCallId: "call_1",
      externalRefs: { messageId: "18f3" },
      payload: { body: "Hi Alice, secret plans", to: ["alice@example.org"] },
    });
    expect(r.payload?.body).toMatchObject({ redacted: "content" });
    expect((await broker.listReceipts({ taskId: "task_1" })).map((x) => x.id)).toEqual([r.id]);
    expect((await broker.listReceipts({ toolCallId: "call_1" })).map((x) => x.id)).toEqual([r.id]);
    const ok = await broker.receipts.reconcile(r.id, {
      outcome: "ok",
      note: "messages.get",
      externalRefs: { threadId: "t1" },
    });
    expect(ok).toMatchObject({
      outcome: "ok",
      externalRefs: { messageId: "18f3", threadId: "t1" },
    });
    await expect(
      broker.receipts.reconcile(r.id, { outcome: "failed", note: "x" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      broker.recordReceipt({ kind: "x", outcome: "ok", summary: "", approvalId: "apr_missing" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
