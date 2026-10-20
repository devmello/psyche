import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundDecisionEvent } from "@psyche/channels";
import { bindingFor } from "@psyche/permissions";
import type { InboundMessage } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { channelReplyAuthority } from "../src/compose/channels.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import type { ComposeServices } from "../src/compose/services.ts";

/** N5: the default iMessage send port, backed by the broker's channel reply authority. */

const ACCOUNT = "me@icloud.test";
const OWNER_CHAT = "iMessage;-;+15550001111";

let home = "";
let composed: ComposedGateway | null = null;
afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function services(): Promise<ComposeServices> {
  home = mkdtempSync(join(tmpdir(), "psyche-reply-"));
  let s: ComposeServices | undefined;
  composed = await composeGateway({
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [
      (x) => {
        s = x;
        return {};
      },
    ],
  });
  return s as ComposeServices;
}

function inbound(chatId: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: "imessage",
    account: ACCOUNT,
    messageId: `m-${chatId}`,
    chatId,
    senderId: "+15550001111",
    isGroup: false,
    text: "hi",
    receivedAt: Date.now(),
    ...over,
  };
}

function decision(
  message: InboundMessage,
  action: "deliver" | "pair",
  role?: "owner" | "paired",
): InboundDecisionEvent {
  return {
    channel: { type: "imessage", account: ACCOUNT } as InboundDecisionEvent["channel"],
    message,
    action,
    ...(role === undefined ? {} : { route: { role } as InboundDecisionEvent["route"] }),
  };
}

function intent(recipient: string, text: string, purpose: "reply" | "approval_card" = "reply") {
  const bodySha256 = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
  const b = bindingFor("message_send", {
    channel: "imessage",
    account: ACCOUNT,
    recipient,
    bodySha256,
  });
  return {
    channel: "imessage" as const,
    account: ACCOUNT,
    recipient,
    bodySha256,
    bindingHash: b.bindingHash,
    grantKey: b.grantKey,
    purpose,
  };
}

describe("default iMessage authorizeSend (N5)", () => {
  it("answers the conversation the owner just wrote in, once, and spends the approval", async () => {
    const s = await services();
    s.channelConversations.record(decision(inbound(OWNER_CHAT), "deliver", "owner"));
    const authorize = channelReplyAuthority(s);
    const id = await authorize(intent(OWNER_CHAT, "Sure, done."));
    expect(await s.rawBroker.get(id)).toMatchObject({
      kind: "message_send",
      status: "approved",
      scopeGranted: "once",
      decidedBy: { channel: "imessage", senderId: "+15550001111" },
    });
    // Spent at dispatch (`verifiedMessagesSends`) against the actual text, once.
    expect(
      await s.rawBroker.verifyBinding(id, intent(OWNER_CHAT, "Sure, done.").bindingHash),
    ).toMatchObject({ ok: true });
    expect(
      await s.rawBroker.verifyBinding(id, intent(OWNER_CHAT, "Sure, done.").bindingHash),
    ).toEqual({ ok: false, reason: "consumed" });
    // Approval cards may go to the owner's own chat.
    await expect(authorize(intent(OWNER_CHAT, "Approve?", "approval_card"))).resolves.toMatch(
      /^apr_/,
    );
  });

  it("refuses chats nobody authorized wrote in, and cards to anyone but the owner", async () => {
    const s = await services();
    s.channelConversations.record(decision(inbound("chat-friend"), "deliver", "paired"));
    s.channelConversations.record(decision(inbound("chat-stranger"), "pair"));
    const authorize = channelReplyAuthority(s);
    await expect(authorize(intent("chat-nobody", "hello"))).rejects.toMatchObject({
      code: "forbidden",
      details: { reason: "unknown_conversation" },
    });
    await expect(authorize(intent("chat-stranger", "hello"))).rejects.toMatchObject({
      details: { reason: "sender_not_allowed" },
    });
    await expect(authorize(intent("chat-friend", "hello"))).resolves.toMatch(/^apr_/);
    await expect(
      authorize(intent("chat-friend", "Approve?", "approval_card")),
    ).rejects.toMatchObject({
      details: { reason: "not_owner_conversation" },
    });
  });
});

describe("pairing confirmation (#277)", () => {
  const STRANGER_CHAT = "iMessage;-;+15550002222";
  const stranger = (chatId = STRANGER_CHAT) => inbound(chatId, { senderId: "+15550002222" });
  const approved = (senderId: string, decision: "approved" | "denied" = "approved") => ({
    channel: { type: "imessage", account: ACCOUNT } as InboundDecisionEvent["channel"],
    senderId,
    decision,
  });

  it("an approved sender's pairing DM is answerable, so the confirmation is authorized", async () => {
    const s = await services();
    s.channelConversations.record(decision(stranger(), "pair"));
    const authorize = channelReplyAuthority(s);
    await expect(
      authorize(intent(STRANGER_CHAT, "You're approved. Say hi!")),
    ).rejects.toMatchObject({
      details: { reason: "sender_not_allowed" },
    });
    s.channelConversations.pairingDecided(approved("+15550002222"));
    await expect(authorize(intent(STRANGER_CHAT, "You're approved. Say hi!"))).resolves.toMatch(
      /^apr_/,
    );
    // Still only a reply: never an owner approval card.
    await expect(
      authorize(intent(STRANGER_CHAT, "Approve?", "approval_card")),
    ).rejects.toMatchObject({ details: { reason: "not_owner_conversation" } });
  });

  it("a denial, another sender, another account or a group changes nothing", async () => {
    const s = await services();
    s.channelConversations.record(decision(stranger(), "pair"));
    s.channelConversations.record(
      decision(inbound("iMessage;+;chat9", { senderId: "+15550002222", isGroup: true }), "pair"),
    );
    s.channelConversations.pairingDecided(approved("+15550002222", "denied"));
    s.channelConversations.pairingDecided(approved("+15550003333"));
    s.channelConversations.pairingDecided({
      ...approved("+15550002222"),
      channel: {
        type: "imessage",
        account: "other@icloud.test",
      } as InboundDecisionEvent["channel"],
    });
    const authorize = channelReplyAuthority(s);
    await expect(authorize(intent(STRANGER_CHAT, "You're approved."))).rejects.toMatchObject({
      details: { reason: "sender_not_allowed" },
    });
    s.channelConversations.pairingDecided(approved("+15550002222"));
    await expect(authorize(intent("iMessage;+;chat9", "You're approved."))).rejects.toMatchObject({
      details: { reason: "sender_not_allowed" },
    });
  });
});
