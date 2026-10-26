import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { MAX_BATCH_CALLS, type PolicyCall } from "../src/index.ts";
import {
  CTX,
  call,
  DEVICE,
  makeBroker,
  memoryDb,
  origin,
  recipient,
  sqliteBroker,
} from "./helpers.ts";

/**
 * Batch approvals (docs/workflows/mail-and-meetings-2026.md §8.1, #670 W2): one approval for a
 * listed set of write calls, bound to the ordered list, once only; on approval one approved
 * child per call, each bound to its own call's binding, consumed once by `verifyBinding`.
 */

const flags = (id: string): PolicyCall =>
  call("mail_set_flags", "write", undefined, { params: { ids: [id], read: true } });

function batch(h: ReturnType<typeof makeBroker>, calls: PolicyCall[], taint = false) {
  return h.broker.requestBatch({
    title: `Mark ${calls.length} newsletters read`,
    children: calls.map((c, i) => ({ call: c, summary: `Mark read: newsletter ${i + 1}` })),
    context: { ...CTX, taint },
    requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
    surfaces: ["desktop", "telegram:42"],
  });
}

async function answer(
  h: ReturnType<typeof makeBroker>,
  issued: Awaited<ReturnType<typeof batch>>,
  decision: "approve" | "deny" = "approve",
) {
  h.clock.advance(500);
  return h.broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop ?? "",
    decision,
    scope: "once",
    decidedBy: DEVICE,
  });
}

describe("batch approvals", () => {
  it("issues one once-only card listing every call; approving mints one child per call", async () => {
    const h = makeBroker();
    const calls = [flags("m1"), flags("m2"), flags("m3")];
    const issued = await batch(h, calls);
    const a = issued.approval;
    expect(a).toMatchObject({
      kind: "batch",
      scopesOffered: ["once"],
      sideEffect: "write",
      status: "pending",
    });
    expect(a.details).toMatchObject({
      count: 3,
      calls: ["Mark read: newsletter 1", "Mark read: newsletter 2", "Mark read: newsletter 3"],
    });
    expect(await h.broker.batchChildren(a.id)).toEqual([]);
    const decided = await answer(h, issued);
    expect(decided.status).toBe("approved");
    const children = await h.broker.batchChildren(a.id);
    expect(children.map((c) => c.call.params)).toEqual(calls.map((c) => c.params));
    expect(
      children.every((c) => c.approval.status === "approved" && c.approval.scopeGranted === "once"),
    ).toBe(true);
    expect(new Set(children.map((c) => c.approval.bindingHash)).size).toBe(3);
    // Children never get a card or a token.
    expect(children.every((c) => c.approval.surfaces.length === 0)).toBe(true);
    // Each child verifies once against its own call's binding, never twice, never another's.
    const [c1, c2] = children;
    expect(
      await h.broker.verifyBinding(c1?.approval.id ?? "", c2?.approval.bindingHash ?? ""),
    ).toMatchObject({ ok: false, reason: "binding_mismatch" });
    expect(
      await h.broker.verifyBinding(c1?.approval.id ?? "", c1?.approval.bindingHash ?? ""),
    ).toMatchObject({ ok: true });
    expect(
      await h.broker.verifyBinding(c1?.approval.id ?? "", c1?.approval.bindingHash ?? ""),
    ).toMatchObject({ ok: false, reason: "consumed" });
  });

  it("binds the ordered list: the same calls in another order are another batch", async () => {
    const h = makeBroker();
    const a = await batch(h, [flags("m1"), flags("m2")]);
    const b = await batch(h, [flags("m2"), flags("m1")]);
    expect(a.approval.bindingHash).not.toBe(b.approval.bindingHash);
  });

  it("a denied batch mints nothing", async () => {
    const h = makeBroker();
    const issued = await batch(h, [flags("m1")]);
    expect((await answer(h, issued, "deny")).status).toBe("denied");
    expect(await h.broker.batchChildren(issued.approval.id)).toEqual([]);
  });

  it("refuses sends, destructive, financial and device-only calls, and empty or oversized lists", async () => {
    const h = makeBroker();
    const send = call("email.send", "destructive", recipient("dana@example.com"), {
      kind: "send_email",
    });
    await expect(batch(h, [flags("m1"), send])).rejects.toMatchObject({ code: "policy_denied" });
    const del = call("mail_delete", "destructive");
    await expect(batch(h, [del])).rejects.toMatchObject({ code: "policy_denied" });
    // The broker's own floor lifts a declared write named like a delete.
    await expect(batch(h, [call("files.delete_item", "write")])).rejects.toMatchObject({
      code: "policy_denied",
    });
    await expect(
      batch(h, [call("link.pay", "write", origin("https://shop.example"))]),
    ).rejects.toMatchObject({ code: "policy_denied" });
    await expect(
      batch(h, [call("credentials.request", "write", undefined, { kind: "credential_fill" })]),
    ).rejects.toMatchObject({ code: "policy_denied" });
    await expect(batch(h, [])).rejects.toMatchObject({ code: "invalid_params" });
    const many = Array.from({ length: MAX_BATCH_CALLS + 1 }, (_, i) => flags(`m${i}`));
    await expect(batch(h, many)).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("carries the batch's taint to the card and every child", async () => {
    const h = makeBroker();
    const issued = await h.broker.requestBatch({
      title: "Archive 2 receipts",
      children: [
        { call: flags("r1"), summary: "Archive: receipt 1" },
        { call: flags("r2"), summary: "Archive: receipt 2" },
      ],
      context: {
        ...CTX,
        taint: true,
        taintSources: [{ sourceKind: "email", sender: "shop@example.com" }],
      },
      requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
      surfaces: ["desktop"],
      taintSources: [{ sourceKind: "email", sender: "shop@example.com" }],
    });
    expect(issued.approval.taint).toBe(true);
    await answer(h, issued);
    const children = await h.broker.batchChildren(issued.approval.id);
    expect(
      children.every(
        (c) => c.approval.taint && c.approval.taintSources?.[0]?.sender === "shop@example.com",
      ),
    ).toBe(true);
  });

  it("children expire after their window", async () => {
    const h = makeBroker();
    const issued = await batch(h, [flags("m1")]);
    await answer(h, issued);
    const [child] = await h.broker.batchChildren(issued.approval.id);
    h.clock.advance(11 * 60_000);
    expect(
      await h.broker.verifyBinding(child?.approval.id ?? "", child?.approval.bindingHash ?? ""),
    ).toMatchObject({ ok: false });
  });

  it("works on the SQLite store too: children survive a new broker on the same database", async () => {
    const db = memoryDb();
    const clock = new FakeClock();
    const first = sqliteBroker(db, clock);
    const issued = await first.requestBatch({
      title: "Mark 2 read",
      children: [flags("m1"), flags("m2")].map((c, i) => ({ call: c, summary: `n${i}` })),
      context: CTX,
      requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
      surfaces: ["desktop"],
    });
    clock.advance(500);
    await first.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens.desktop ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: DEVICE,
    });
    const children = await sqliteBroker(db, clock).batchChildren(issued.approval.id);
    expect(children.map((c) => c.approval.id)).toEqual([
      `${issued.approval.id}.0`,
      `${issued.approval.id}.1`,
    ]);
    expect(children.every((c) => c.approval.status === "approved")).toBe(true);
  });
});
