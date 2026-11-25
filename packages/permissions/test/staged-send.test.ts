import { sha256 } from "@psyche/audit";
import { describe, expect, it } from "vitest";
import {
  type PolicyCall,
  type StagedApplyChildInput,
  stagedSendBindingHash,
} from "../src/index.ts";
import { CTX, DEVICE, makeBroker } from "./helpers.ts";

/**
 * `bindStagedSend` (docs/design/night-shift-2026.md §3.2): the owner's one tap approved a send
 * child bound to the saved draft's content hash and recipients. Only an exact match turns it into
 * the approval for the concrete send call, once.
 */

const IDS: ReadonlySet<string> = new Set(["apple", "google"]);
const TO = ["ann@x.com", "bob@x.com"];
const HASH = "c0ffee".padEnd(64, "0");

const exact = (
  tool: string,
  sideEffect: PolicyCall["sideEffect"],
  params: Record<string, unknown>,
  extra: Partial<PolicyCall> = {},
): PolicyCall => ({
  tool,
  sideEffect,
  params,
  paramsHash: sha256(JSON.stringify(params)),
  ...extra,
});

function sendChild(itemId: string, tool = "gmail_send", to = TO): StagedApplyChildInput {
  return {
    itemId: `${itemId}:send`,
    call: exact(
      tool,
      "destructive",
      { to },
      {
        kind: "send_email",
        targetKind: "recipient",
        target: { kind: "recipient", value: to.join(",") },
        bindingHash: stagedSendBindingHash(tool, HASH, to),
        grantKey: `send_email|staged:${itemId}:send`,
      },
    ),
    summary: `Send to ${to.join(", ")}`,
    explicitSend: true,
    recipients: [...to],
  };
}

/** The concrete send W5 builds once the draft is saved and read back. */
const concrete = (over: Record<string, unknown> = {}, tool = "gmail_send"): PolicyCall => {
  const params = { to: TO, subject: "Re: lunch", body: "Tuesday works", threadId: "t-1", ...over };
  const to = (params.to as string[]).join(",");
  return exact(tool, "destructive", params, {
    kind: "send_email",
    targetKind: "recipient",
    target: { kind: "recipient", value: to },
    bindingHash: `sha256:${sha256(JSON.stringify(params)).slice(7)}`,
    grantKey: `send_email:gmail:${to}`,
  });
};

async function approved(tool = "gmail_send") {
  const h = makeBroker();
  const draft: StagedApplyChildInput = {
    itemId: "item_1",
    call: exact("gmail_create_draft", "write", { to: TO, subject: "Re: lunch" }),
    summary: "Save a reply draft",
  };
  const issued = await h.broker.requestStagedApply({
    title: "Apply 1 prepared change",
    children: [draft, sendChild("item_1", tool)],
    context: CTX,
    requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
    surfaces: ["desktop"],
    connectorIds: IDS,
    details: { nightShift: { op: "apply", reviewId: "night_1" } },
  });
  expect(issued.refused).toEqual([]);
  h.clock.advance(500);
  await h.broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop ?? "",
    decision: "approve",
    scope: "once",
    decidedBy: DEVICE,
  });
  const children = await h.broker.batchChildren(issued.approval.id);
  const send = children.find((c) => c.approval.requestedBy.toolCallId === "item_1:send");
  if (send === undefined) throw new Error("no send child");
  return { h, issued, send };
}

const bind = (
  h: ReturnType<typeof makeBroker>,
  childApprovalId: string,
  over: Partial<{ itemId: string; sendHash: string; call: PolicyCall }> = {},
) =>
  h.broker.bindStagedSend({
    childApprovalId,
    itemId: over.itemId ?? "item_1:send",
    sendHash: over.sendHash ?? HASH,
    call: over.call ?? concrete(),
    connectorIds: IDS,
  });

describe("bindStagedSend: the exact match binds (control)", () => {
  it("consumes the send child and returns a once-only, device-only approval for the concrete call", async () => {
    const { h, send } = await approved();
    const call = concrete();
    const a = await bind(h, send.approval.id, { call });
    expect(a).toMatchObject({
      kind: "send_email",
      status: "approved",
      scopeGranted: "once",
      deviceOnly: true,
      requiresAuthentication: false,
      bindingHash: call.bindingHash,
    });
    expect(a.requestedBy.toolCallId).toBe("item_1:send");
    // The new approval is consumed once by verifyBinding, never twice.
    expect((await h.broker.verifyBinding(a.id, a.bindingHash)).ok).toBe(true);
    expect(await h.broker.verifyBinding(a.id, a.bindingHash)).toEqual({
      ok: false,
      reason: "consumed",
    });
    // The child it came from is spent: it can't send by itself either.
    expect((await h.broker.verifyBinding(send.approval.id, send.approval.bindingHash)).ok).toBe(
      false,
    );
  });
});

describe("bindStagedSend: refusals (two-way: each row's control is the exact match above)", () => {
  const rows: [
    string,
    (h: ReturnType<typeof makeBroker>, id: string) => Promise<unknown>,
    string,
  ][] = [
    [
      "the draft body changed after the save (another content hash)",
      (h, id) => bind(h, id, { sendHash: "d1ff".padEnd(64, "0") }),
      "binding_mismatch",
    ],
    [
      "a recipient added to the concrete call",
      (h, id) => bind(h, id, { call: concrete({ to: [...TO, "eve@evil.test"] }) }),
      "recipients_changed",
    ],
    [
      "a recipient that differs from the stored record",
      (h, id) => bind(h, id, { call: concrete({ to: ["ann@x.com", "eve@evil.test"] }) }),
      "recipients_changed",
    ],
    [
      "a recipient dropped",
      (h, id) => bind(h, id, { call: concrete({ to: ["ann@x.com"] }) }),
      "recipients_changed",
    ],
    ["another item's id", (h, id) => bind(h, id, { itemId: "item_2:send" }), "another_item"],
    [
      "another tool",
      (h, id) => bind(h, id, { call: concrete({}, "mail_send_draft") }),
      "another_tool",
    ],
    [
      "a call without a binding hash",
      (h, id) => bind(h, id, { call: { ...concrete(), bindingHash: undefined } as PolicyCall }),
      "no_binding",
    ],
    ["an approval that is not a staged child", (h) => bind(h, "appr_nope"), "not_found"],
  ];

  it.each(rows)("refuses %s", async (_name, run, reason) => {
    const { h, send } = await approved();
    await expect(run(h, send.approval.id)).rejects.toMatchObject({
      code: "binding_mismatch",
      details: { reason },
    });
    // A refusal spends nothing: the exact match still binds afterwards.
    await expect(bind(h, send.approval.id)).resolves.toMatchObject({ status: "approved" });
  });

  it("refuses a second consume", async () => {
    const { h, send } = await approved();
    await bind(h, send.approval.id);
    await expect(bind(h, send.approval.id)).rejects.toMatchObject({
      details: { reason: "consumed" },
    });
  });

  it("refuses a send child already consumed by verifyBinding", async () => {
    const { h, send } = await approved();
    expect((await h.broker.verifyBinding(send.approval.id, send.approval.bindingHash)).ok).toBe(
      true,
    );
    await expect(bind(h, send.approval.id)).rejects.toMatchObject({
      details: { reason: "consumed" },
    });
  });

  it("refuses a replayed answer token on the staged apply", async () => {
    const { h, issued } = await approved();
    await expect(
      h.broker.answer({
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop ?? "",
        decision: "approve",
        scope: "once",
        decidedBy: DEVICE,
      }),
    ).rejects.toBeDefined();
  });

  it("refuses a child of an ordinary batch (not a staged apply)", async () => {
    const h = makeBroker();
    const c = exact("mail_set_flags", "write", { ids: ["m1"], read: true });
    const issued = await h.broker.requestBatch({
      title: "Mark read",
      children: [{ call: c, summary: "Mark read" }],
      context: CTX,
      requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
      surfaces: ["desktop"],
    });
    h.clock.advance(500);
    await h.broker.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens.desktop ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: DEVICE,
    });
    const [child] = await h.broker.batchChildren(issued.approval.id);
    await expect(bind(h, child?.approval.id ?? "")).rejects.toMatchObject({
      details: { reason: "not_staged" },
    });
  });
});
