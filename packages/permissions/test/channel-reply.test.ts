import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  bindingFor,
  CHANNEL_REPLIES_PER_MINUTE,
  CHANNEL_REPLY_WINDOW_MS,
  type ChannelConversation,
} from "../src/index.ts";
import { makeBroker, memoryDb, sqliteBroker } from "./helpers.ts";

const BODY = `sha256:${"a".repeat(64)}`;
const OWNER_CHAT = "iMessage;-;+15550001111";

function harness(conversations: Record<string, Partial<ChannelConversation>>) {
  const h = makeBroker({
    channelConversations: ({ channel, account, conversation }) => {
      if (channel !== "imessage" || account !== "me@icloud.test") return undefined;
      const c = conversations[conversation];
      return c === undefined
        ? undefined
        : {
            senderId: "+15550001111",
            lastInboundAt: h.clock.now(),
            allows: "reply",
            owner: false,
            isGroup: false,
            ...c,
          };
    },
  });
  return h;
}

const send = (
  recipient: string,
  purpose: "reply" | "pairing_code" | "approval_card" = "reply",
) => ({
  channel: "imessage",
  account: "me@icloud.test",
  recipient,
  bodySha256: BODY,
  purpose,
});

describe("authorizeChannelReply (N5)", () => {
  it("issues an approved once message_send for the conversation that sender just wrote in", async () => {
    const h = harness({ [OWNER_CHAT]: { owner: true } });
    const a = await h.broker.authorizeChannelReply(send(OWNER_CHAT));
    const binding = bindingFor("message_send", {
      channel: "imessage",
      account: "me@icloud.test",
      recipient: OWNER_CHAT,
      bodySha256: BODY,
    });
    expect(a).toMatchObject({
      kind: "message_send",
      status: "approved",
      scopeGranted: "once",
      decidedBy: { channel: "imessage", senderId: "+15550001111" },
      bindingHash: binding.bindingHash,
    });
    // The node's verification consumes it: once means once.
    expect(await h.broker.verifyBinding(a.id, binding.bindingHash)).toMatchObject({ ok: true });
    expect(await h.broker.verifyBinding(a.id, binding.bindingHash)).toEqual({
      ok: false,
      reason: "consumed",
    });
    // Never a card: no notification, no pending approval; audited.
    expect(await h.notifier.list()).toHaveLength(0);
    expect(await h.broker.list({ status: "pending" })).toHaveLength(0);
    expect(await h.audit.query({ kind: "approval.channel_reply" })).toHaveLength(1);
  });

  it("binds the exact text and recipient", async () => {
    const h = harness({ [OWNER_CHAT]: {} });
    const a = await h.broker.authorizeChannelReply(send(OWNER_CHAT));
    const other = bindingFor("message_send", {
      channel: "imessage",
      account: "me@icloud.test",
      recipient: OWNER_CHAT,
      bodySha256: `sha256:${"b".repeat(64)}`,
    });
    expect(await h.broker.verifyBinding(a.id, other.bindingHash)).toEqual({
      ok: false,
      reason: "binding_mismatch",
    });
    await expect(
      h.broker.authorizeChannelReply({ ...send(OWNER_CHAT), bindingHash: other.bindingHash }),
    ).rejects.toMatchObject({ code: "forbidden", details: { reason: "binding_mismatch" } });
  });

  it("refuses conversations nobody authorized wrote in, and stale ones", async () => {
    const h = harness({
      "chat-stranger": { allows: "pairing_code" },
      "chat-old": { lastInboundAt: 0 },
    });
    h.clock.advance(CHANNEL_REPLY_WINDOW_MS + 1);
    await expect(h.broker.authorizeChannelReply(send("chat-nobody"))).rejects.toMatchObject({
      code: "forbidden",
      details: { reason: "unknown_conversation" },
    });
    await expect(h.broker.authorizeChannelReply(send("chat-stranger"))).rejects.toMatchObject({
      details: { reason: "sender_not_allowed" },
    });
    await expect(h.broker.authorizeChannelReply(send("chat-old"))).rejects.toMatchObject({
      details: { reason: "stale_conversation" },
    });
    await expect(
      h.broker.authorizeChannelReply({ ...send(OWNER_CHAT), account: "other@icloud.test" }),
    ).rejects.toMatchObject({ details: { reason: "unknown_conversation" } });
    expect(await h.audit.query({ kind: "approval.channel_reply_refused" })).toHaveLength(4);
  });

  it("pairing codes go only to a fresh pairing conversation; approval cards only to the owner's DM", async () => {
    const h = harness({
      "chat-stranger": { allows: "pairing_code" },
      "chat-friend": {},
      [OWNER_CHAT]: { owner: true },
      "chat-group": { owner: true, isGroup: true },
    });
    await expect(
      h.broker.authorizeChannelReply(send("chat-stranger", "pairing_code")),
    ).resolves.toMatchObject({ status: "approved" });
    await expect(
      h.broker.authorizeChannelReply(send("chat-friend", "pairing_code")),
    ).rejects.toMatchObject({ details: { reason: "not_pairing" } });
    await expect(
      h.broker.authorizeChannelReply(send(OWNER_CHAT, "approval_card")),
    ).resolves.toMatchObject({ status: "approved" });
    for (const chat of ["chat-friend", "chat-group"]) {
      await expect(
        h.broker.authorizeChannelReply(send(chat, "approval_card")),
      ).rejects.toMatchObject({ details: { reason: "not_owner_conversation" } });
    }
  });

  it("caps sends per conversation and refuses without a channel policy", async () => {
    const h = harness({ [OWNER_CHAT]: {} });
    for (let i = 0; i < CHANNEL_REPLIES_PER_MINUTE; i += 1) {
      await h.broker.authorizeChannelReply(send(OWNER_CHAT));
    }
    await expect(h.broker.authorizeChannelReply(send(OWNER_CHAT))).rejects.toMatchObject({
      code: "rate_limited",
    });
    const bare = makeBroker();
    await expect(bare.broker.authorizeChannelReply(send(OWNER_CHAT))).rejects.toMatchObject({
      details: { reason: "no_channel_policy" },
    });
  });

  it("persists the decided approval in the SQLite store", async () => {
    const db = memoryDb();
    const clock = new FakeClock();
    const broker = sqliteBroker(db, clock, {
      channelConversations: () => ({
        senderId: "+15550001111",
        lastInboundAt: clock.now(),
        allows: "reply",
        owner: true,
        isGroup: false,
      }),
    });
    const a = await broker.authorizeChannelReply(send(OWNER_CHAT));
    expect(await broker.get(a.id)).toMatchObject({ status: "approved", scopeGranted: "once" });
  });
});
