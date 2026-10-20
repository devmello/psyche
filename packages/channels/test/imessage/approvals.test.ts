import type { ApprovalRequestInput } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { TAPBACK_HINT } from "../../src/adapters/imessage/index.ts";
import { approvalRef } from "../../src/format/approval-card.ts";
import { dm, FRIEND, harness, lastEcho, OWNER } from "./helpers.ts";

function input(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    kind: "send_email",
    summary: 'Send "Re: invoice" to alice@example.org',
    details: { to: "alice@example.org", subject: "Re: invoice" },
    bindingHash: `sha256:${"a".repeat(64)}`,
    grantKey: "email.send:example.org",
    requestedBy: { runId: "run1", taskId: null, threadId: "t1" },
    sideEffect: "write",
    surfaces: ["desktop", `imessage:${OWNER}`],
    taint: false,
    ...overrides,
  };
}

const like = (targetGuid: string, kind: "like" | "dislike" = "like", removed = false) => ({
  kind,
  removed,
  targetGuid,
});

describe("iMessage approvals over chat", () => {
  it("delivers a plain-text card with the /approve fallback; the owner's /approve answers it", async () => {
    const h = await harness();
    h.node.receive({ from: OWNER, text: "hi" });
    await h.settle();
    const issued = await h.broker.requestApproval(input());
    expect(await h.service.deliverApproval(issued)).toEqual([
      { surface: `imessage:${OWNER}`, delivered: true },
    ]);
    const ref = approvalRef(issued.approval.id);
    const card = h.node.sends.at(-1);
    expect(card?.chatId).toBe(dm(OWNER));
    expect(card?.text.split("\n")[0]).toBe("Send email · write");
    expect(card?.text).toContain(`Reply "/approve ${ref} approve" or "/approve ${ref} deny".`);
    expect(card?.text.endsWith(TAPBACK_HINT)).toBe(true);
    expect(card?.text).not.toContain(issued.answerTokens[`imessage:${OWNER}`] ?? "?");
    expect(h.intents.at(-1)?.purpose).toBe("approval_card");

    h.clock.advance(1000);
    h.node.receive({ from: OWNER, text: `/approve ${ref} approve` });
    await h.settle();
    const decided = await h.broker.get(issued.approval.id);
    expect(decided?.status).toBe("approved");
    expect(decided?.scopeGranted).toBe("once");
    expect(decided?.decidedBy).toEqual({ channel: "imessage", senderId: OWNER });
    expect(h.sent().at(-1)).toBe("Approved: Send an email.");
    // Commands never reach the agent.
    expect(h.delivered.map((e) => e.message.text)).toEqual(["hi"]);
  });

  it("rejects /approve from a non-owner", async () => {
    const h = await harness({ channel: { allowFrom: [OWNER, FRIEND] } });
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    h.clock.advance(1000);
    h.node.receive({ from: FRIEND, text: `/approve ${approvalRef(issued.approval.id)} approve` });
    await h.settle();
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
    expect(h.node.sends.at(-1)).toMatchObject({
      chatId: dm(FRIEND),
      text: "Commands are only available to the owner.",
    });
  });

  it("a 👍 / 👎 tapback on the card answers it, only from the owner's iMessage identity", async () => {
    const h = await harness({ channel: { allowFrom: [OWNER, FRIEND] } });
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    const card = await lastEcho(h.node);
    const sendsBefore = h.node.sends.length;
    h.clock.advance(1000);

    // Ignored: a non-owner (another chat), the owner's number over SMS, a removed tapback, other kinds.
    h.node.receive({ from: FRIEND, text: null, reaction: like(card.guid) });
    h.node.receive({ from: OWNER, text: null, service: "sms", reaction: like(card.guid) });
    h.node.receive({ from: OWNER, text: null, reaction: like(card.guid, "like", true) });
    h.node.receive({
      from: OWNER,
      text: null,
      reaction: { kind: "love", removed: false, targetGuid: card.guid },
    });
    await h.settle();
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
    // None of them reached the approval router (it would have replied).
    expect(h.node.sends).toHaveLength(sendsBefore);

    h.node.receive({ from: OWNER, text: null, reaction: like(card.guid, "dislike") });
    await h.settle();
    const decided = await h.broker.get(issued.approval.id);
    expect(decided?.status).toBe("denied");
    expect(decided?.decidedBy).toEqual({ channel: "imessage", senderId: OWNER });
    expect(h.sent().at(-1)).toBe("Denied: Send an email.");
    // Tapbacks are never inbound turns.
    expect(h.delivered).toHaveLength(0);
  });

  it("device-only approvals get the header and 'Answer this on your Mac.' and cannot be answered", async () => {
    const h = await harness();
    h.node.receive({ from: OWNER, text: "hi" });
    await h.settle();
    const issued = await h.broker.requestApproval(
      input({ kind: "purchase", sideEffect: "financial", summary: "Buy 2 tickets" }),
    );
    const token = "tok-forced";
    // A broker that forgot to strip chat surfaces: the channel layer still refuses.
    const reports = await h.service.deliverApproval({
      approval: { ...issued.approval, deviceOnly: true },
      answerTokens: { ...issued.answerTokens, [`imessage:${OWNER}`]: token },
    });
    expect(reports).toEqual([
      { surface: `imessage:${OWNER}`, delivered: false, reason: "device_only" },
    ]);
    expect(h.sent().at(-1)).toBe("Pay · financial\nAnswer this on your Mac.");
    await expect(
      h.adapter.sendApprovalButtons(OWNER, { ...issued.approval, deviceOnly: true }, token),
    ).rejects.toMatchObject({ code: "forbidden" });

    const pointer = await lastEcho(h.node);
    h.clock.advance(1000);
    h.node.receive({ from: OWNER, text: null, reaction: like(pointer.guid) });
    h.node.receive({ from: OWNER, text: `/approve ${approvalRef(issued.approval.id)} approve` });
    await h.settle();
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
    expect(h.sent().at(-1)).toBe("No pending approval with that ref.");
  });

  it("a card sent to the owner's handle before they have written lands in their 1:1 chat", async () => {
    const h = await harness();
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    const send = h.node.sends.at(-1);
    expect(send).toMatchObject({ to: OWNER, service: "imessage" });
    expect(h.intents.at(-1)?.recipient).toBe(OWNER);
    const card = await lastEcho(h.node);
    expect(card.chatId).toBe(dm(OWNER));
    h.clock.advance(1000);
    h.node.receive({ from: OWNER, text: null, reaction: like(card.guid) });
    await h.settle();
    expect((await h.broker.get(issued.approval.id))?.status).toBe("approved");
  });

  it("a refused send authorization sends nothing", async () => {
    const h = await harness({
      adapter: {
        authorizeSend: async () => {
          throw new Error("denied on the Mac");
        },
      },
    });
    h.node.receive({ from: OWNER, text: "hi" });
    await h.settle();
    await expect(
      h.service.send({ channelId: h.channel.id, chatId: dm(OWNER) }, "hello"),
    ).rejects.toThrow("denied on the Mac");
    expect(h.node.sends).toHaveLength(0);
    expect(h.node.invocations.some((i) => i.capability === "messages.send")).toBe(false);
  });
});
