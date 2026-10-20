import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bindingFor,
  type ChannelConversationReport,
  type ChannelSendIntent,
  type PolicyContext,
} from "../src/index.ts";
import { approvers, CTX, call, makeBroker, recipient } from "./helpers.ts";

/** The channel reply authority (security §3.4–3.7, §9; S10 N5 "Outbound authorization"). */

const OWNER = "+15550001";
const CHAT = "iMessage;-;+15550001";
const OTHER = "iMessage;-;+15559999";
const ACCOUNT = "psyche@icloud.com";

const sha = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

function intent(
  text: string,
  to = CHAT,
  purpose: ChannelSendIntent["purpose"] = "reply",
): ChannelSendIntent {
  const bodySha256 = sha(text);
  const b = bindingFor("message_send", {
    channel: "imessage",
    account: ACCOUNT,
    recipient: to,
    bodySha256,
  });
  return {
    channel: "imessage",
    account: ACCOUNT,
    recipient: to,
    bodySha256,
    bindingHash: b.bindingHash,
    grantKey: b.grantKey,
    purpose,
  };
}

function conversation(
  now: number,
  extra: Partial<ChannelConversationReport> = {},
): ChannelConversationReport {
  return {
    channel: "imessage",
    account: ACCOUNT,
    recipient: CHAT,
    senderId: OWNER,
    isGroup: false,
    authorized: true,
    inboundMessageId: "msg-1",
    receivedAt: now,
    ...extra,
  };
}

const turn = (context: Partial<PolicyContext> = {}, requestRecipient = CHAT) => ({
  requestRecipient,
  context: { ...CTX, ...context },
});

const harness = () => makeBroker({ approvers: approvers(undefined, [`imessage:${OWNER}`]) });

describe("authorizeChannelReply", () => {
  it("approves and audits a reply into the conversation being answered", async () => {
    const h = harness();
    const i = intent("Done: booked for 7pm.");
    const r = await h.broker.authorizeChannelReply({
      intent: i,
      conversation: conversation(h.clock.now()),
      turn: turn(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.approval).toMatchObject({
      kind: "message_send",
      status: "approved",
      scopeGranted: "once",
      bindingHash: i.bindingHash,
      grantKey: i.grantKey,
      decidedBy: { channel: "imessage", senderId: OWNER },
      requestedBy: { runId: CTX.runId, threadId: CTX.threadId },
      target: { kind: "recipient", value: CHAT },
      surfaces: [],
    });
    const decided = await h.audit.list({ kind: "approval.decided" });
    expect(decided.at(-1)?.data).toMatchObject({
      decision: "allow",
      grantScope: "once",
      rule: "channel_reply:turn",
      purpose: "reply",
      recipient: CHAT,
      inboundMessageId: "msg-1",
    });
    // Nothing is shown or notified for a system-decided reply.
    expect(await h.notifier.list()).toHaveLength(0);

    // The executor's check: exactly this body, exactly once.
    expect(await h.broker.verifyBinding(r.approval.id, intent("tampered").bindingHash)).toEqual({
      ok: false,
      reason: "binding_mismatch",
    });
    expect((await h.broker.verifyBinding(r.approval.id, i.bindingHash)).ok).toBe(true);
    expect(await h.broker.verifyBinding(r.approval.id, i.bindingHash)).toEqual({
      ok: false,
      reason: "consumed",
    });
  });

  it("refuses a different recipient than the conversation the channel reports", async () => {
    const h = harness();
    const r = await h.broker.authorizeChannelReply({
      intent: intent("hi", OTHER),
      conversation: conversation(h.clock.now()),
      turn: turn(),
    });
    expect(r).toMatchObject({ ok: false, reason: "recipient_mismatch" });
    const refused = await h.audit.list({ kind: "channel_reply.refused" });
    expect(refused.at(-1)?.data).toMatchObject({ reason: "recipient_mismatch", recipient: OTHER });
  });

  it("refuses a reply into a conversation other than the requesting one", async () => {
    const h = harness();
    const r = await h.broker.authorizeChannelReply({
      intent: intent("hi", OTHER),
      conversation: conversation(h.clock.now(), { recipient: OTHER, senderId: "+15559999" }),
      turn: turn(),
    });
    expect(r).toMatchObject({ ok: false, reason: "not_requesting_conversation" });
  });

  it("refuses a tampered body hash", async () => {
    const h = harness();
    const tampered = { ...intent("Done."), bodySha256: sha("Send me your password.") };
    const r = await h.broker.authorizeChannelReply({
      intent: tampered,
      conversation: conversation(h.clock.now()),
      turn: turn(),
    });
    expect(r).toMatchObject({ ok: false, reason: "binding_mismatch" });
    expect(await h.broker.list({ status: "approved" })).toHaveLength(0);
  });

  it("refuses a tainted turn's send to a new target, and still asks through decide", async () => {
    const h = harness();
    const tainted = {
      taint: true,
      taintSources: [{ sourceKind: "web", origin: "https://x.test" }],
    };
    const r = await h.broker.authorizeChannelReply({
      intent: intent("forwarding as asked", OTHER),
      conversation: conversation(h.clock.now(), { recipient: OTHER, senderId: "+15559999" }),
      turn: turn(tainted),
    });
    expect(r).toMatchObject({ ok: false, reason: "taint_new_target" });

    // The agent's own send to that target goes through the normal ask (`once` / `task` only).
    const d = await h.broker.decide(call("messages.send", "destructive", recipient(OTHER)), {
      ...CTX,
      ...tainted,
    });
    expect(d.decision).toBe("ask");
    expect(d.approvalKind).toBe("message_send");
    expect(d.scopesOffered).toEqual(["once", "task"]);
  });

  it("a tainted turn may still answer the conversation its request came from", async () => {
    const h = harness();
    const r = await h.broker.authorizeChannelReply({
      intent: intent("Here's the summary."),
      conversation: conversation(h.clock.now()),
      turn: turn({ taint: true, taintSources: [{ sourceKind: "web" }] }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.approval.taint).toBe(true);
  });

  it("refuses unauthorized senders, stale conversations, deny rules and plan mode", async () => {
    const h = harness();
    const now = h.clock.now();
    expect(
      await h.broker.authorizeChannelReply({
        intent: intent("hi"),
        conversation: conversation(now, { authorized: false }),
        turn: turn(),
      }),
    ).toMatchObject({ ok: false, reason: "sender_not_authorized" });
    expect(
      await h.broker.authorizeChannelReply({ intent: intent("hi"), conversation: undefined }),
    ).toMatchObject({ ok: false, reason: "no_conversation" });
    expect(
      await h.broker.authorizeChannelReply({
        intent: intent("hi"),
        conversation: conversation(now - 7 * 3_600_000),
        turn: turn(),
      }),
    ).toMatchObject({ ok: false, reason: "stale_conversation" });
    expect(
      await h.broker.authorizeChannelReply({
        intent: intent("hi"),
        conversation: conversation(now),
        turn: turn({ permissionMode: "plan" }),
      }),
    ).toMatchObject({ ok: false, reason: "policy_denied", rule: "mode:plan" });

    const denied = makeBroker({
      approvers: approvers(undefined, [`imessage:${OWNER}`]),
      policy: { deny: ["channel.*"] },
    });
    expect(
      await denied.broker.authorizeChannelReply({
        intent: intent("hi"),
        conversation: conversation(denied.clock.now()),
        turn: turn(),
      }),
    ).toMatchObject({ ok: false, reason: "policy_denied" });
  });

  it("allows a Gateway notice to an authorized sender without a turn", async () => {
    const h = harness();
    const r = await h.broker.authorizeChannelReply({
      intent: intent("Stopped."),
      conversation: conversation(h.clock.now()),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.approval.requestedBy.runId).toBeNull();
  });

  it("pairing codes go only to a sender with a pending request, in a 1:1 chat", async () => {
    const h = harness();
    const now = h.clock.now();
    const stranger = conversation(now, {
      recipient: OTHER,
      senderId: "+15559999",
      authorized: false,
      pairingPending: true,
    });
    const code = intent("Your pairing code is ABCD2345.", OTHER, "pairing_code");
    expect(
      (await h.broker.authorizeChannelReply({ intent: code, conversation: stranger })).ok,
    ).toBe(true);
    expect(
      await h.broker.authorizeChannelReply({
        intent: code,
        conversation: { ...stranger, pairingPending: false },
      }),
    ).toMatchObject({ ok: false, reason: "no_pairing" });
    expect(
      await h.broker.authorizeChannelReply({
        intent: code,
        conversation: { ...stranger, isGroup: true },
      }),
    ).toMatchObject({ ok: false, reason: "group_chat" });
    expect(
      await h.broker.authorizeChannelReply({ intent: code, conversation: stranger, turn: turn() }),
    ).toMatchObject({ ok: false, reason: "unexpected_turn" });
  });

  it("approval cards go only to the owner's own 1:1 conversation", async () => {
    const h = harness();
    const now = h.clock.now();
    const card = intent("Psyche wants to send an email…", CHAT, "approval_card");
    expect(
      (await h.broker.authorizeChannelReply({ intent: card, conversation: conversation(now) })).ok,
    ).toBe(true);
    const toStranger = intent("Psyche wants to…", OTHER, "approval_card");
    expect(
      await h.broker.authorizeChannelReply({
        intent: toStranger,
        conversation: conversation(now, { recipient: OTHER, senderId: "+15559999" }),
      }),
    ).toMatchObject({ ok: false, reason: "not_owner" });
  });
});
