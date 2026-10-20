import type { ApprovalRequestInput } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { WebChatAdapter, webChatChannelDefaults } from "../src/adapters/webchat.ts";
import { approvalRef } from "../src/format/approval-card.ts";
import { chunkMessage } from "../src/format/chunk.ts";
import { renderMarkdown } from "../src/format/markdown.ts";
import { channelSettings } from "../src/settings.ts";
import { harness, OWNER, sentTexts } from "./helpers.ts";

// Regressions for the S10 pre-PR security review (findings 2, 3, 4, 5, 6, 8, 10).

function input(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    kind: "send_email",
    summary: "Send a reply to alice@example.org",
    details: { to: "alice@example.org" },
    bindingHash: `sha256:${"a".repeat(64)}`,
    grantKey: "email.send:example.org",
    requestedBy: { runId: "run1", taskId: null, threadId: "t1" },
    sideEffect: "write",
    surfaces: [`telegram:${OWNER}`],
    taint: false,
    ...overrides,
  };
}

describe("review regressions", () => {
  it("forwarded text starting with / is never a command (finding 2)", async () => {
    const h = await harness();
    await h.adapter.receive({ senderId: OWNER, text: "/stop", forwardedFrom: { senderId: "9" } });
    expect(h.delivered.map((d) => d.kind)).toEqual(["message"]);
    expect(h.delivered[0]?.parts[0]?.provenance).toBe("untrusted");
  });

  it("WebChat never carries or answers chat approval cards (finding 3)", async () => {
    const h = await harness();
    await h.service.saveChannel({
      ...h.service.newChannel("webchat", "web"),
      ...webChatChannelDefaults(),
    });
    const web = new WebChatAdapter();
    const replies: string[] = [];
    web.onOutbound((m) => {
      if (m.messageId !== "typing") replies.push(m.text);
    });
    const { id } = h.service.attach(web);
    await h.service.start(id);
    expect(h.service.ownerSurfaces()).toEqual([`telegram:${OWNER}`]);
    const issued = await h.broker.requestApproval(input({ surfaces: ["webchat:owner"] }));
    const reports = await h.service.deliverApproval(issued);
    expect(reports.every((r) => !r.delivered)).toBe(true);
    h.clock.advance(1000);
    await web.receive("any-device", `/approve ${approvalRef(issued.approval.id)} approve`);
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
    expect(replies.at(-1)).toBe("Answer approvals on the approval card.");
  });

  it("a card too long for chat cannot be approved from chat (finding 4)", async () => {
    const h = await harness({ capabilities: { buttons: false, maxMessageChars: 300 } });
    const issued = await h.broker.requestApproval(input({ details: { body: "x".repeat(400) } }));
    const reports = await h.service.deliverApproval(issued);
    expect(reports).toEqual([
      { surface: `telegram:${OWNER}`, delivered: false, reason: "too_long_for_chat" },
    ]);
    expect(sentTexts(h).at(-1)).toMatch(/Open on your Mac to review/);
    h.clock.advance(1000);
    await h.adapter.receive({
      senderId: OWNER,
      text: `/approve ${approvalRef(issued.approval.id)} approve`,
    });
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
  });

  it("one failed surface does not stop delivery to the others (finding 5)", async () => {
    const h = await harness({ ownerAllowFrom: ["telegram:777"] });
    const original = h.adapter.sendApprovalButtons.bind(h.adapter);
    h.adapter.sendApprovalButtons = async (chatId, approval, token) => {
      if (chatId === OWNER) throw new PsycheError("forbidden", "bot was blocked by the user");
      return original(chatId, approval, token);
    };
    const issued = await h.broker.requestApproval(
      input({ surfaces: [`telegram:${OWNER}`, "telegram:777"] }),
    );
    const reports = await h.service.deliverApproval(issued);
    expect(reports).toEqual([
      { surface: `telegram:${OWNER}`, delivered: false, reason: "send_failed:forbidden" },
      { surface: "telegram:777", delivered: true },
    ]);
  });

  it("the pending cap holds under concurrent unknown senders (finding 6)", async () => {
    const h = await harness();
    await Promise.all(
      ["11", "12", "13", "14", "15", "16"].map((id) =>
        h.adapter.receive({ senderId: id, text: "hi" }),
      ),
    );
    expect(await h.service.listPairings({ status: "pending" })).toHaveLength(3);
  });

  it("chunks fit both the source and the rendered limit (finding 8)", () => {
    const text = "abcdefghij\r\n".repeat(370);
    const chunks = chunkMessage(text, 4096, { format: "markdown", flavor: "telegram-html" });
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4096);
      expect(renderMarkdown(c, "telegram-html").length).toBeLessThanOrEqual(4096);
    }
  });

  it("mis-nested emphasis renders as escaped plain text (finding 9)", () => {
    expect(renderMarkdown("**a _b** c_ <x>", "telegram-html")).toBe("a b c &lt;x&gt;");
  });

  it("a fractional burst cannot stall sends (finding 10)", async () => {
    const h = await harness({
      channel: { config: { rateLimit: { burst: 0.5, perChatPerSec: 1 } } },
    });
    expect(channelSettings(h.service.getChannel(h.channel.id)).rateLimit.burst).toBe(1);
    await h.service.send({ channelId: h.channel.id, chatId: OWNER }, "one");
    await h.service.send({ channelId: h.channel.id, chatId: OWNER }, "two");
    expect(sentTexts(h)).toEqual(["one", "two"]);
    expect(h.sleeps).toEqual([1000]);
  });
});
