import { describe, expect, it } from "vitest";
import {
  isMentioned,
  mapUpdate,
  parseApprovalCallback,
} from "../../src/adapters/telegram/index.ts";
import { BOT_INFO, harness, OWNER_ID, T0, update } from "./helpers.ts";

const BOT = { id: BOT_INFO.id, username: BOT_INFO.username };

describe("TelegramAdapter inbound mapping", () => {
  it("maps a text DM with a strong identity", async () => {
    const { adapter, inbound, api } = await harness();
    await adapter.handleUpdate(update("dmText"));
    expect(inbound).toEqual([
      {
        channel: "telegram",
        account: "psyche_bot",
        messageId: "501",
        chatId: OWNER_ID,
        senderId: OWNER_ID,
        senderName: "Ada Lovelace",
        isGroup: false,
        mentioned: false,
        text: "Remind me to call the dentist tomorrow at 9",
        receivedAt: T0,
        identityStrength: "strong",
      },
    ]);
    expect(api.calls).toEqual([]);
  });

  it("detects a group mention only from a structured entity (UTF-16 offsets, any case)", async () => {
    const { adapter, inbound } = await harness();
    await adapter.handleUpdate(update("groupMention"));
    await adapter.handleUpdate(update("groupPlainAt"));
    await adapter.handleUpdate(update("groupOtherMention"));
    expect(inbound.map((m) => [m.chatId, m.isGroup, m.mentioned])).toEqual([
      ["-1001987654321", true, true],
      ["-1001987654321", true, false],
      ["-1001987654321", true, false],
    ]);
    expect(inbound[1]?.text).toBe("@psyche_bot hi");
  });

  it("treats text_mention of the bot and /command@bot as mentions", async () => {
    const { adapter, inbound } = await harness();
    await adapter.handleUpdate(update("groupTextMention"));
    await adapter.handleUpdate(update("groupBotCommand"));
    expect(inbound.map((m) => [m.chatId, m.isGroup, m.mentioned])).toEqual([
      ["-4012345678", true, true],
      ["-4012345678", true, true],
    ]);
  });

  it("does not count a bot_command addressed to another bot", () => {
    const u = update("groupBotCommand");
    const msg = u.message;
    if (msg === undefined) throw new Error("fixture");
    msg.text = "/summary@other_bot";
    msg.entities = [{ type: "bot_command", offset: 0, length: 18 }];
    expect(isMentioned(msg, BOT)).toBe(false);
  });

  it("maps a reply to the bot's message, preferring the quoted fragment", async () => {
    const { adapter, inbound } = await harness();
    await adapter.handleUpdate(update("replyToBot"));
    await adapter.handleUpdate(update("replyToBotNoQuote"));
    expect(inbound[0]?.replyToMessageId).toBe("502");
    expect(inbound[0]?.quoted).toEqual({
      text: "Should I tell Sam?",
      senderId: String(BOT_INFO.id),
      fromSelf: true,
    });
    expect(inbound[0]?.text).toBe("yes");
    expect(inbound[1]?.quoted?.text).toBe("Your 3pm meeting moved to 4pm. Should I tell Sam?");
    expect(inbound[1]?.quoted?.fromSelf).toBe(true);
  });

  it("records the forward origin separately from the sender", async () => {
    const { adapter, inbound } = await harness();
    await adapter.handleUpdate(update("forwardUser"));
    await adapter.handleUpdate(update("forwardHidden"));
    await adapter.handleUpdate(update("forwardChannel"));
    expect(inbound.map((m) => [m.senderId, m.forwardedFrom])).toEqual([
      [OWNER_ID, { senderId: "99887766", senderName: "Sam Carter" }],
      [OWNER_ID, { senderName: "Mystery Person" }],
      [OWNER_ID, { senderId: "-1001555000111", senderName: "Lovelace Updates" }],
    ]);
    // Plain "@psyche_bot" inside forwarded text has no entity: not a mention.
    expect(inbound[1]?.mentioned).toBe(false);
  });

  it("marks anonymous admins as weak chat senders", async () => {
    const { adapter, inbound } = await harness();
    await adapter.handleUpdate(update("anonymousAdmin"));
    expect(inbound[0]).toMatchObject({
      senderId: "1087968824",
      senderName: "Lovelace Family",
      identityStrength: "weak",
      senderIsChat: true,
      mentioned: true,
    });
  });

  it("marks the Telegram service account as weak even without sender_chat", () => {
    const u = update("dmText");
    if (u.message === undefined) throw new Error("fixture");
    u.message.from = { id: 777000, is_bot: false, first_name: "Telegram" };
    const m = mapUpdate(u, BOT, "psyche_bot");
    expect(m?.identityStrength).toBe("weak");
    expect(m?.senderIsChat).toBe(true);
  });

  it("maps an edit with editOf and a distinct message id", async () => {
    const { adapter, inbound } = await harness();
    await adapter.handleUpdate(update("edited"));
    expect(inbound[0]).toMatchObject({
      messageId: `501:e${T0 / 1000 + 45}`,
      editOf: "501",
      receivedAt: T0 + 45_000,
      text: "Remind me to call the dentist tomorrow at 10",
    });
  });

  it("maps a voice note to a voice attachment with ref and duration", async () => {
    const { adapter, inbound } = await harness();
    await adapter.handleUpdate(update("voice"));
    expect(inbound[0]?.text).toBe("");
    expect(inbound[0]?.attachments).toEqual([
      {
        kind: "voice",
        name: "voice.ogg",
        mime: "audio/ogg",
        size: 23456,
        ref: "AwACAgEAAxkBAAIB_GZ2b2ljZS1ub3RlLWZpbGUtaWQAAk4F",
        durationMs: 7000,
      },
    ]);
  });

  it("keeps the largest photo size and maps documents with caption text", async () => {
    const { adapter, inbound } = await harness();
    await adapter.handleUpdate(update("photo"));
    await adapter.handleUpdate(update("document"));
    expect(inbound[0]?.text).toBe("receipt from lunch");
    expect(inbound[0]?.attachments).toEqual([
      {
        kind: "image",
        name: "photo.jpg",
        mime: "image/jpeg",
        size: 96544,
        ref: "AgACAgEAAxkBAAIB_WZwaG90by1sYXJnZQACq6sxGw",
      },
    ]);
    expect(inbound[1]?.text).toBe("can you summarize this?");
    expect(inbound[1]?.attachments).toEqual([
      {
        kind: "file",
        name: "lease.pdf",
        mime: "application/pdf",
        size: 482113,
        ref: "BQACAgEAAxkBAAIB_mZkb2N1bWVudC1sZWFzZQACeQUAAg",
      },
    ]);
  });

  it("ignores the bot's own messages and channel posts", async () => {
    const { adapter, inbound } = await harness();
    await adapter.handleUpdate(update("fromSelf"));
    await adapter.handleUpdate(update("channelPost"));
    expect(inbound).toEqual([]);
  });

  it("swallows handler exceptions and keeps delivering", async () => {
    const { adapter, inbound } = await harness();
    adapter.onInbound(() => {
      throw new Error("handler blew up");
    });
    await adapter.handleUpdate(update("dmText"));
    await adapter.handleUpdate(update("voice"));
    expect(inbound).toHaveLength(2);
    expect(adapter.handlerErrors).toBe(2);
  });

  it("unsubscribes handlers", async () => {
    const { adapter, inbound } = await harness();
    const seen: string[] = [];
    const off = adapter.onInbound((m) => {
      seen.push(m.messageId);
    });
    await adapter.handleUpdate(update("dmText"));
    off();
    await adapter.handleUpdate(update("voice"));
    expect(seen).toEqual(["501"]);
    expect(inbound).toHaveLength(2);
  });

  it("parses only well-formed approval callback data", () => {
    expect(parseApprovalCallback("a:AbCdEfGh_-12:y")).toEqual({
      nonce: "AbCdEfGh_-12",
      decision: "approve",
    });
    expect(parseApprovalCallback("a:AbCdEfGh_-12:n")?.decision).toBe("deny");
    expect(parseApprovalCallback("a:short:y")).toBeUndefined();
    expect(parseApprovalCallback("a:AbCdEfGh_-12:x")).toBeUndefined();
    expect(parseApprovalCallback(undefined)).toBeUndefined();
  });
});
