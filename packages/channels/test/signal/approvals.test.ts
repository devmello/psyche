import type { ApprovalRequestInput } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { SIGNAL_REACTION_HINT } from "../../src/adapters/signal/index.ts";
import { FRIEND, GROUP_ID, type Harness, harness, OWNER, reactionEnvelope } from "./helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function input(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    kind: "send_email",
    summary: 'Send "Re: invoice" to alice@example.org',
    details: { to: "alice@example.org", subject: "Re: invoice" },
    bindingHash: `sha256:${"a".repeat(64)}`,
    grantKey: "email.send:example.org",
    requestedBy: { runId: "run1", taskId: null, threadId: "t1" },
    sideEffect: "write",
    surfaces: ["desktop", `signal:${OWNER}`],
    taint: false,
    ...overrides,
  };
}

describe("Signal approvals (👍 / 👎 only)", () => {
  it("sends the card with the reaction hint; the owner's 👍 approves it exactly once", async () => {
    h = await harness({ channel: { allowFrom: [OWNER, FRIEND] } });
    const issued = await h.broker.requestApproval(input());
    expect(await h.service.deliverApproval(issued)).toEqual([
      { surface: `signal:${OWNER}`, delivered: true },
    ]);
    const card = h.daemon.sent().at(-1);
    expect(card?.params.recipient).toEqual([OWNER]);
    const text = String(card?.params.message);
    expect(text.split("\n")[0]).toBe("Send email · write");
    expect(text.endsWith(`\n${SIGNAL_REACTION_HINT}`)).toBe(true);
    expect(text).not.toContain("/approve");
    expect(text).not.toContain(issued.answerTokens[`signal:${OWNER}`] ?? "?");
    const cardTs = h.daemon.lastSentTimestamp;
    h.clock.advance(1000);

    h.daemon.push(reactionEnvelope(OWNER, cardTs, "👍"));
    await h.settle();
    const decided = await h.broker.get(issued.approval.id);
    expect(decided?.status).toBe("approved");
    expect(decided?.scopeGranted).toBe("once");
    expect(decided?.decidedBy).toEqual({ channel: "signal", senderId: OWNER });
    expect(h.daemon.sentTexts().at(-1)).toBe("Approved: Send an email.");

    // A second 👍 is a replay: the broker keeps the first answer.
    h.daemon.push(reactionEnvelope(OWNER, cardTs, "👍"));
    await h.settle();
    expect((await h.broker.get(issued.approval.id))?.status).toBe("approved");
    expect(h.daemon.sentTexts().at(-1)).toBe("That approval was already answered.");
    // Reactions are never inbound turns.
    expect(h.delivered).toHaveLength(0);
  });

  it("ignores a non-owner's 👍, a removed reaction, other emoji and reactions to others' messages", async () => {
    const chatId = `group:${GROUP_ID}`;
    h = await harness({
      channel: { allowFrom: [OWNER, FRIEND], config: { groups: { [chatId]: {} } } },
    });
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    const cardTs = h.daemon.lastSentTimestamp;
    const sendsBefore = h.daemon.sent().length;
    h.clock.advance(1000);

    h.daemon.push(reactionEnvelope(FRIEND, cardTs, "👍"));
    h.daemon.push(reactionEnvelope(FRIEND, cardTs, "👍", { groupId: GROUP_ID }));
    h.daemon.push(reactionEnvelope(OWNER, cardTs, "👍", { isRemove: true }));
    h.daemon.push(reactionEnvelope(OWNER, cardTs, "❤️"));
    h.daemon.push(reactionEnvelope(OWNER, cardTs, "👍", { targetAuthor: FRIEND }));
    h.daemon.push(reactionEnvelope(OWNER, cardTs + 1000, "👍"));
    await h.settle();
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
    // None of them reached the approval router (it would have replied).
    expect(h.daemon.sent()).toHaveLength(sendsBefore);
    expect(h.delivered).toHaveLength(0);
  });

  it("the owner's 👎 denies", async () => {
    h = await harness();
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    const cardTs = h.daemon.lastSentTimestamp;
    h.clock.advance(1000);
    h.daemon.push(reactionEnvelope(OWNER, cardTs, "👎🏻"));
    await h.settle();
    const decided = await h.broker.get(issued.approval.id);
    expect(decided?.status).toBe("denied");
    expect(h.daemon.sentTexts().at(-1)).toBe("Denied: Send an email.");
  });

  it("device-only approvals get the header and 'Answer this on your Mac.' with no hint", async () => {
    h = await harness();
    const issued = await h.broker.requestApproval(
      input({ kind: "purchase", sideEffect: "financial", summary: "Buy 2 tickets" }),
    );
    const token = "tok-forced";
    // A broker that forgot to strip chat surfaces: the channel layer still refuses.
    const reports = await h.service.deliverApproval({
      approval: { ...issued.approval, deviceOnly: true },
      answerTokens: { ...issued.answerTokens, [`signal:${OWNER}`]: token },
    });
    expect(reports).toEqual([
      { surface: `signal:${OWNER}`, delivered: false, reason: "device_only" },
    ]);
    const pointer = h.daemon.sentTexts().at(-1);
    expect(pointer).toBe("Pay · financial\nAnswer this on your Mac.");
    expect(pointer).not.toContain(SIGNAL_REACTION_HINT);
    await expect(
      h.adapter.sendApprovalButtons(OWNER, { ...issued.approval, deviceOnly: true }, token),
    ).rejects.toMatchObject({ code: "forbidden" });

    const pointerTs = h.daemon.lastSentTimestamp;
    h.clock.advance(1000);
    h.daemon.push(reactionEnvelope(OWNER, pointerTs, "👍"));
    await h.settle();
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
  });

  it("never sends a card into a group", async () => {
    h = await harness();
    const issued = await h.broker.requestApproval(input());
    await expect(
      h.adapter.sendApprovalButtons(`group:${GROUP_ID}`, issued.approval, "tok"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
