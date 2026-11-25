import { DEVICE_ONLY_TEXT } from "@psyche/permissions/cards";
import type { ApprovalRequestInput } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { approvalChatSurfaces } from "../src/approval-routing.ts";
import { plainDecision } from "../src/approvals.ts";
import { approvalRef } from "../src/format/approval-card.ts";
import {
  CHANNEL_TEXT_LANGUAGES,
  channelText,
  localizeCardText,
  setChannelTextLanguage,
} from "../src/text.ts";
import { FRIEND, GROUP, harness, OWNER, sentTexts } from "./helpers.ts";

function input(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    kind: "send_email",
    summary: 'Send "Re: invoice" to bob@x.com',
    details: { to: "bob@x.com", subject: "Re: invoice" },
    bindingHash: `sha256:${"a".repeat(64)}`,
    grantKey: "email.send:x.com",
    requestedBy: { runId: "run1", taskId: null, threadId: "t1" },
    sideEffect: "write",
    target: { kind: "origin", value: "bob@x.com" },
    surfaces: ["desktop", `telegram:${OWNER}`],
    taint: false,
    ...overrides,
  };
}

afterEach(() => setChannelTextLanguage(undefined));

describe("a plain yes or no answers the one open card", () => {
  it("approves once, names the target, and edits the card with the outcome", async () => {
    const h = await harness({ capabilities: { buttons: false, reactions: false } });
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    h.clock.advance(1000);
    await h.adapter.receive({ senderId: OWNER, receivedAt: h.clock.now(), text: "yes" });
    const decided = await h.broker.get(issued.approval.id);
    expect(decided?.status).toBe("approved");
    expect(decided?.scopeGranted).toBe("once");
    expect(sentTexts(h)).toContain("Approved: Send email — bob@x.com.");
    expect(h.delivered).toHaveLength(0);
  });

  it.each([
    ["👍", "approved"],
    ["ok", "approved"],
    ["No.", "denied"],
    ["👎", "denied"],
  ])("%s answers", async (text, status) => {
    const h = await harness({ capabilities: { buttons: false, reactions: false } });
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    h.clock.advance(1000);
    await h.adapter.receive({ senderId: OWNER, receivedAt: h.clock.now(), text });
    expect((await h.broker.get(issued.approval.id))?.status).toBe(status);
  });

  it("with two open cards asks which one and answers neither", async () => {
    const h = await harness({ capabilities: { buttons: false, reactions: false } });
    const a = await h.broker.requestApproval(input());
    const b = await h.broker.requestApproval(input({ bindingHash: `sha256:${"b".repeat(64)}` }));
    await h.service.deliverApproval(a);
    await h.service.deliverApproval(b);
    h.clock.advance(1000);
    await h.adapter.receive({ senderId: OWNER, receivedAt: h.clock.now(), text: "yes" });
    expect(sentTexts(h).at(-1)).toBe("Which one? Reply with the ref.");
    expect((await h.broker.get(a.approval.id))?.status).toBe("pending");
    expect((await h.broker.get(b.approval.id))?.status).toBe("pending");
    expect(h.delivered).toHaveLength(0);
  });

  it("never in a group, never from a non-owner", async () => {
    const h = await harness({
      capabilities: { buttons: false, reactions: false },
      channel: { allowFrom: [OWNER, FRIEND] },
    });
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    h.clock.advance(1000);
    await h.adapter.receive({
      senderId: OWNER,
      receivedAt: h.clock.now(),
      chatId: GROUP,
      isGroup: true,
      text: "yes",
    });
    await h.adapter.receive({ senderId: FRIEND, receivedAt: h.clock.now(), text: "yes" });
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
  });

  it("a yes with no open card goes to the agent as before", async () => {
    const h = await harness();
    await h.adapter.receive({ senderId: OWNER, receivedAt: h.clock.now(), text: "yes" });
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.message.text).toBe("yes");
  });

  it.each([
    ["purchase", "financial"],
    ["credential_fill", "write"],
    ["exec_host", "write"],
    ["policy_change", "write"],
    ["pairing", "write"],
    ["file_write", "destructive"],
  ] as const)("%s (%s) is a pointer: yes does not answer it", async (kind, sideEffect) => {
    const h = await harness({ capabilities: { buttons: false, reactions: false } });
    const issued = await h.broker.requestApproval(input({ kind, sideEffect }));
    // A Broker that forgot to strip the chat surface: the channel layer still refuses.
    const forced = {
      approval: { ...issued.approval, deviceOnly: false },
      answerTokens: { ...issued.answerTokens, [`telegram:${OWNER}`]: "tok" },
    };
    await h.service.deliverApproval(forced);
    h.clock.advance(1000);
    await h.adapter.receive({ senderId: OWNER, receivedAt: h.clock.now(), text: "yes" });
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
    // The one open card is a pointer: the owner is told where to answer it, not the agent.
    expect(h.delivered).toHaveLength(0);
    expect(sentTexts(h).at(-1)).toBe("This one needs your Mac or iPhone.");
    expect(sentTexts(h)[0]).toContain(DEVICE_ONLY_TEXT);
  });

  it("a destructive card is answerable by yes only when the channel allows it", async () => {
    for (const allow of [true, false]) {
      const h = await harness({
        capabilities: { buttons: false, reactions: false },
        channel: { config: { allowDestructiveApprovals: allow } },
      });
      // Issued as a write (a real token), shown to the chat as a destructive one.
      const issued = await h.broker.requestApproval(input({ kind: "file_write" }));
      await h.service.deliverApproval({
        ...issued,
        approval: { ...issued.approval, sideEffect: "destructive" },
      });
      h.clock.advance(1000);
      await h.adapter.receive({ senderId: OWNER, receivedAt: h.clock.now(), text: "yes" });
      expect((await h.broker.get(issued.approval.id))?.status).toBe(allow ? "approved" : "pending");
    }
  });

  it("plainDecision accepts only a bare yes or no", () => {
    for (const t of ["yes", " Yes! ", "y", "ok", "👍", "👍🏽"])
      expect(plainDecision(t)).toBe("approve");
    for (const t of ["no", "n", "deny", "👎"]) expect(plainDecision(t)).toBe("deny");
    for (const t of ["yes please send it", "no way", "maybe", "", "yes?", "okay then"]) {
      expect(plainDecision(t)).toBeUndefined();
    }
  });
});

describe("pointer cards", () => {
  it("/deny <ref> denies a pointer; /approve <ref> on it is still refused", async () => {
    const h = await harness({ capabilities: { buttons: false, reactions: false } });
    // Issued as a write (a real token), shown to the chat as a destructive one: a pointer.
    const issued = await h.broker.requestApproval(input({ kind: "file_write" }));
    await h.service.deliverApproval({
      ...issued,
      approval: { ...issued.approval, sideEffect: "destructive" },
    });
    const ref = approvalRef(issued.approval.id);
    expect(sentTexts(h)[0]).toContain(DEVICE_ONLY_TEXT);
    expect(sentTexts(h)[0]).toContain(`To deny, reply "/deny ${ref}".`);
    expect(sentTexts(h)[0]).not.toContain("/approve");
    h.clock.advance(1000);
    await h.adapter.receive({
      senderId: OWNER,
      receivedAt: h.clock.now(),
      text: `/approve ${ref} approve`,
    });
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
    expect(sentTexts(h).at(-1)).toBe("This approval can only be answered on a paired device.");
    await h.adapter.receive({ senderId: OWNER, receivedAt: h.clock.now(), text: `/deny ${ref}` });
    expect((await h.broker.get(issued.approval.id))?.status).toBe("denied");
  });
});

describe("settled cards are retired", () => {
  it("a button press acks after the verdict, with the real verdict", async () => {
    const h = await harness({ capabilities: { reactions: false } });
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    const card = h.adapter.sent.find((s) => s.kind === "approval_buttons");
    h.clock.advance(1000);
    await h.adapter.press({
      approvalId: issued.approval.id,
      answerToken: card?.answerToken ?? "",
      decision: "approve",
      senderId: OWNER,
    });
    expect(h.adapter.acks.at(-1)).toEqual({ text: "Approved.", decided: true });
    // Pressed again: the verdict is the Broker's, not "sent".
    await h.adapter.press({
      approvalId: issued.approval.id,
      answerToken: card?.answerToken ?? "",
      decision: "approve",
      senderId: OWNER,
    });
    expect(h.adapter.acks.at(-1)).toEqual({
      text: "That approval was already answered.",
      decided: false,
    });
  });

  it("an adapter that can edit gets the card rewritten with the outcome", async () => {
    const h = await harness({ capabilities: { reactions: false }, canEdit: true });
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    const card = h.adapter.sent.find((s) => s.kind === "approval_buttons");
    h.clock.advance(31 * 60_000);
    const expired = await h.broker.get(issued.approval.id);
    expect(expired?.status).toBe("expired");
    await h.service.retireApproval(expired ?? issued.approval);
    expect(h.adapter.edits).toEqual([
      {
        chatId: OWNER,
        messageId: card?.messageId,
        approvalId: issued.approval.id,
        text: "Send email · write\nExpired. Nothing was done.",
      },
    ]);
    // Once only.
    await h.service.retireApproval(expired ?? issued.approval);
    expect(h.adapter.edits).toHaveLength(1);
  });

  it("a chat that cannot edit gets one follow-up, only while the card is the last message", async () => {
    const h = await harness({ capabilities: { buttons: false, reactions: false } });
    const first = await h.broker.requestApproval(input());
    await h.service.deliverApproval(first);
    h.clock.advance(1000);
    const stopped = {
      ...first.approval,
      status: "invalidated" as const,
      invalidatedReason: "run_cancelled",
    };
    await h.service.retireApproval(stopped);
    expect(sentTexts(h).at(-1)).toBe(
      "Send email · write\nStopped with the task. Nothing was done.",
    );

    const second = await h.broker.requestApproval(
      input({ bindingHash: `sha256:${"c".repeat(64)}` }),
    );
    await h.service.deliverApproval(second);
    await h.adapter.receive({
      senderId: OWNER,
      receivedAt: h.clock.now(),
      text: "meanwhile, something else",
    });
    const before = sentTexts(h).length;
    await h.service.retireApproval({ ...second.approval, status: "expired" });
    expect(sentTexts(h)).toHaveLength(before);
  });
});

describe("fixed lines follow ui.language", () => {
  it("every language translates the pointer, the expiry line and the retire lines", () => {
    for (const language of CHANNEL_TEXT_LANGUAGES) {
      if (language === "en") continue;
      expect(localizeCardText(DEVICE_ONLY_TEXT, language)).not.toBe(DEVICE_ONLY_TEXT);
      const expires = localizeCardText("Expires in 7 min · ref abcd1234", language);
      expect(expires).not.toBe("Expires in 7 min · ref abcd1234");
      expect(expires).toContain("7");
      expect(expires).toContain("abcd1234");
      expect(channelText("whichOne", {}, language)).not.toBe(channelText("whichOne", {}, "en"));
      expect(channelText("retireExpired", {}, language)).not.toBe("Expired. Nothing was done.");
      const header = localizeCardText(
        "Send email · write · after reading untrusted content",
        language,
      );
      expect(header).not.toContain("Send email");
      expect(header).not.toContain("untrusted");
    }
  });

  it("request text that only looks like a fixed line is left alone", () => {
    const hostile = [
      "Expires in many min · ref zzzz",
      "Send email · write · and more",
      "Answer this on Mars.",
    ];
    for (const line of hostile) expect(localizeCardText(line, "de")).toBe(line);
  });

  it("the cards a chat gets are in the owner's language", async () => {
    const h = await harness({ capabilities: { buttons: false, reactions: false } });
    setChannelTextLanguage(() => "de");
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    const card = sentTexts(h)[0] ?? "";
    expect(card).toContain("Läuft in");
    expect(card).toContain("E-Mail senden");
    expect(card).toContain("Ziel: “bob@x.com”");
    expect(card).toContain("/approve");
  });
});

describe("routing: which chats get a card", () => {
  const base = {
    ownerSurfaces: ["telegram:1", "slack:U1"],
    awaySurfaces: ["slack:U1"],
    deviceLastSeenAt: 1_000_000 as number | null,
    deviceConnected: false,
    now: 1_000_000 + 60_000,
    awayAfterMs: 10 * 60_000,
  };
  it.each([
    ["chat-started run: that chat only", { originSurface: "telegram:1" }, ["telegram:1"]],
    [
      "chat-started run ignores a recent device",
      { originSurface: "telegram:1", deviceConnected: true },
      ["telegram:1"],
    ],
    [
      "chat-started run from a chat that is not an owner chat: none",
      { originSurface: "telegram:99" },
      [],
    ],
    ["Mac run, device seen a minute ago: no chat", {}, []],
    ["Mac run, device connected: no chat", { deviceConnected: true, now: 99_000_000 }, []],
    [
      "Mac run, no device for N min: the away chat only",
      { now: 1_000_000 + 10 * 60_000 },
      ["slack:U1"],
    ],
    ["Mac run, no device ever paired: the away chat", { deviceLastSeenAt: null }, ["slack:U1"]],
    ["Mac run, away chat unset: no chat", { now: 99_000_000, awaySurfaces: [] }, []],
    [
      "Mac run, away chat no longer an owner chat: none",
      { now: 99_000_000, awaySurfaces: ["slack:U9"] },
      [],
    ],
  ] as const)("%s", (_name, over, expected) => {
    expect(approvalChatSurfaces({ ...base, ...over })).toEqual(expected);
  });
});

describe("a plain yes is bound to the card it answers", () => {
  const plain = { capabilities: { buttons: false, reactions: false } } as const;
  const cardId = (h: Awaited<ReturnType<typeof harness>>, n = 0) =>
    h.adapter.sent.filter((x) => x.text.includes("Expires in"))[n]?.messageId;

  it("a yes sent before the card was delivered is not an answer (poll, backlog, same second)", async () => {
    for (const lag of [-2000, -1, 0]) {
      const h = await harness(plain);
      h.clock.advance(5000);
      const issued = await h.broker.requestApproval(input());
      await h.service.deliverApproval(issued);
      // receivedAt = delivery time + lag: strictly after is the only answer.
      await h.adapter.receive({ senderId: OWNER, receivedAt: h.clock.now() + lag, text: "yes" });
      expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
      expect(h.delivered.map((d) => d.message.text)).toEqual(["yes"]);
    }
    const h = await harness(plain);
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    h.clock.advance(1000);
    await h.adapter.receive({ senderId: OWNER, receivedAt: h.clock.now(), text: "yes" });
    expect((await h.broker.get(issued.approval.id))?.status).toBe("approved");
  });

  it("a missing receive time, or an attachment, is never an answer", async () => {
    const h = await harness(plain);
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    h.clock.advance(1000);
    await h.adapter.receive({ senderId: OWNER, receivedAt: 0, text: "yes" });
    await h.adapter.receive({
      senderId: OWNER,
      receivedAt: h.clock.now(),
      text: "yes",
      attachments: [{ kind: "image", name: "a.png", mimeType: "image/png", ref: "r" }] as never,
    });
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
  });

  it("a swipe-reply answers the card it names, even among several", async () => {
    const h = await harness(plain);
    const a = await h.broker.requestApproval(input());
    const b = await h.broker.requestApproval(input({ bindingHash: `sha256:${"b".repeat(64)}` }));
    await h.service.deliverApproval(a);
    await h.service.deliverApproval(b);
    h.clock.advance(1000);
    await h.adapter.receive({
      senderId: OWNER,
      receivedAt: h.clock.now(),
      text: "yes",
      replyToMessageId: cardId(h, 1) ?? "",
    });
    expect((await h.broker.get(b.approval.id))?.status).toBe("approved");
    expect((await h.broker.get(a.approval.id))?.status).toBe("pending");
  });

  it("a swipe-reply to an answered card or to another message answers nothing", async () => {
    const h = await harness(plain);
    const a = await h.broker.requestApproval(input());
    const b = await h.broker.requestApproval(input({ bindingHash: `sha256:${"b".repeat(64)}` }));
    await h.service.deliverApproval(a);
    await h.service.deliverApproval(b);
    h.clock.advance(1000);
    const old = cardId(h, 0) ?? "";
    await h.adapter.receive({
      senderId: OWNER,
      receivedAt: h.clock.now(),
      text: "no",
      replyToMessageId: old,
    });
    expect((await h.broker.get(a.approval.id))?.status).toBe("denied");
    h.clock.advance(1000);
    for (const replyToMessageId of [old, "some-other-message"]) {
      await h.adapter.receive({
        senderId: OWNER,
        receivedAt: h.clock.now(),
        text: "yes",
        replyToMessageId,
      });
    }
    await h.adapter.receive({
      senderId: OWNER,
      receivedAt: h.clock.now(),
      text: "yes",
      quoted: { text: "Want me to continue?", fromSelf: true },
    });
    expect((await h.broker.get(b.approval.id))?.status).toBe("pending");
    expect(h.delivered).toHaveLength(3);
  });

  it("after the agent says something else, a bare yes goes to the agent", async () => {
    const h = await harness(plain);
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    h.clock.advance(1000);
    await h.service.send({ channelId: h.channel.id, chatId: OWNER }, "Should I also archive it?");
    h.clock.advance(1000);
    await h.adapter.receive({ senderId: OWNER, receivedAt: h.clock.now(), text: "yes" });
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
    expect(h.delivered.map((d) => d.message.text)).toEqual(["yes"]);
  });

  it("the router's own replies (Which one?, confirmations) do not take the card's place", async () => {
    const h = await harness(plain);
    const a = await h.broker.requestApproval(input());
    const b = await h.broker.requestApproval(input({ bindingHash: `sha256:${"b".repeat(64)}` }));
    await h.service.deliverApproval(a);
    await h.service.deliverApproval(b);
    h.clock.advance(1000);
    await h.adapter.receive({ senderId: OWNER, receivedAt: h.clock.now(), text: "yes" });
    expect(sentTexts(h).at(-1)).toBe("Which one? Reply with the ref.");
    h.clock.advance(1000);
    await h.adapter.receive({
      senderId: OWNER,
      receivedAt: h.clock.now(),
      text: `/approve ${approvalRef(a.approval.id)} approve`,
    });
    h.clock.advance(1000);
    await h.adapter.receive({ senderId: OWNER, receivedAt: h.clock.now(), text: "yes" });
    expect((await h.broker.get(b.approval.id))?.status).toBe("approved");
  });
});

describe("display of the target", () => {
  it("a lookalike host in the target is shown as punycode in the confirmation", async () => {
    const h = await harness({ capabilities: { buttons: false, reactions: false } });
    const issued = await h.broker.requestApproval(
      input({ target: { kind: "origin", value: "https://аpple.com" } }),
    );
    await h.service.deliverApproval(issued);
    h.clock.advance(1000);
    await h.adapter.receive({ senderId: OWNER, receivedAt: h.clock.now(), text: "yes" });
    expect(sentTexts(h).at(-1)).toContain("xn--");
  });

  it("Discord text is markdown-escaped so a target cannot become a masked link", async () => {
    const { escapeDiscordText } = await import("../src/text.ts");
    expect(escapeDiscordText("[click](https://evil.example) @everyone")).toBe(
      "\\[click\\]\\(https://evil.example\\) @\u200beveryone",
    );
  });
});
