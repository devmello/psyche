import type { ApprovalRequestInput } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { approvalRef } from "../src/format/approval-card.ts";
import { FRIEND, harness, OWNER, sentTexts } from "./helpers.ts";

function input(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    kind: "send_email",
    summary: 'Send "Re: invoice" to alice@example.org',
    details: { to: "alice@example.org", subject: "Re: invoice" },
    bindingHash: `sha256:${"a".repeat(64)}`,
    grantKey: "email.send:example.org",
    requestedBy: { runId: "run1", taskId: null, threadId: "t1" },
    sideEffect: "write",
    surfaces: ["desktop", `telegram:${OWNER}`],
    taint: false,
    ...overrides,
  };
}

describe("approvals over chat", () => {
  it("button round trip: first answer wins, a replayed press is rejected", async () => {
    const h = await harness();
    const issued = await h.broker.requestApproval(input());
    const reports = await h.service.deliverApproval(issued);
    expect(reports).toEqual([{ surface: `telegram:${OWNER}`, delivered: true }]);
    const card = h.adapter.sent.find((s) => s.kind === "approval_buttons");
    expect(card).toMatchObject({ chatId: OWNER, approvalId: issued.approval.id });
    h.clock.advance(1000);
    const press = {
      approvalId: issued.approval.id,
      answerToken: card?.answerToken ?? "",
      decision: "approve" as const,
      senderId: OWNER,
    };
    await h.adapter.press(press);
    expect((await h.broker.get(issued.approval.id))?.status).toBe("approved");
    expect((await h.broker.get(issued.approval.id))?.decidedBy).toEqual({
      channel: "telegram",
      senderId: OWNER,
    });
    expect(sentTexts(h).at(-1)).toBe("Approved: Send an email.");
    await h.adapter.press(press);
    expect(sentTexts(h).at(-1)).toBe("That approval was already answered.");
  });

  it("rejects presses before the card is armed, and from non-owners", async () => {
    const h = await harness({ channel: { allowFrom: [OWNER, FRIEND] } });
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    const token = h.adapter.sent.find((s) => s.kind === "approval_buttons")?.answerToken ?? "";
    await h.adapter.press({
      approvalId: issued.approval.id,
      answerToken: token,
      decision: "approve",
      senderId: OWNER,
    });
    expect(sentTexts(h).at(-1)).toMatch(/Too quick/);
    h.clock.advance(1000);
    await h.adapter.press({
      approvalId: issued.approval.id,
      answerToken: token,
      decision: "approve",
      senderId: FRIEND,
    });
    expect(sentTexts(h).at(-1)).toBe("Only the owner can answer approvals.");
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
  });

  it("/approve fallback on a channel without buttons", async () => {
    const h = await harness({ capabilities: { buttons: false } });
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    const ref = approvalRef(issued.approval.id);
    expect(sentTexts(h).at(-1)).toContain(`/approve ${ref} approve`);
    h.clock.advance(1000);
    await h.adapter.receive({ senderId: OWNER, text: `/approve ${ref} deny` });
    expect((await h.broker.get(issued.approval.id))?.status).toBe("denied");
    expect(sentTexts(h).at(-1)).toBe("Denied: Send an email.");
    await h.adapter.receive({ senderId: OWNER, text: `/approve ${ref} approve` });
    expect(sentTexts(h).at(-1)).toBe("That approval was already answered.");
    await h.adapter.receive({ senderId: OWNER, text: "/approve zzzzzzzz approve" });
    expect(sentTexts(h).at(-1)).toBe("No pending approval with that ref.");
    await h.adapter.receive({ senderId: OWNER, text: "/approve" });
    expect(sentTexts(h).at(-1)).toMatch(/^Usage/);
  });

  it("expired and restart-invalidated approvals answer with a short message", async () => {
    const h = await harness();
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    const token = h.adapter.sent.find((s) => s.kind === "approval_buttons")?.answerToken ?? "";
    h.clock.advance(31 * 60_000);
    await h.adapter.press({
      approvalId: issued.approval.id,
      answerToken: token,
      decision: "approve",
      senderId: OWNER,
    });
    expect(sentTexts(h).at(-1)).toMatch(/expired/);

    const second = await h.broker.requestApproval(input());
    await h.service.deliverApproval(second);
    const stale =
      h.adapter.sent.filter((s) => s.kind === "approval_buttons").at(-1)?.answerToken ?? "";
    const [reissued] = await h.broker.reissue();
    h.clock.advance(1000);
    await h.adapter.press({
      approvalId: second.approval.id,
      answerToken: stale,
      decision: "approve",
      senderId: OWNER,
    });
    expect(sentTexts(h).at(-1)).toMatch(/replaced/);
    expect(reissued).toBeDefined();
  });

  it("never delivers device-only, financial, purchase or (by default) destructive approvals", async () => {
    const h = await harness();
    const cases: Partial<ApprovalRequestInput>[] = [
      { kind: "purchase", sideEffect: "financial" },
      { kind: "credential_fill" },
      { kind: "exec_host" },
      { kind: "file_write", sideEffect: "destructive" },
    ];
    for (const c of cases) {
      const issued = await h.broker.requestApproval(input(c));
      // Simulate a broker that forgot to strip chat surfaces: the channel layer still refuses.
      const forced = {
        approval: { ...issued.approval, deviceOnly: false },
        answerTokens: { ...issued.answerTokens, [`telegram:${OWNER}`]: "tok" },
      };
      const reports = await h.service.deliverApproval(forced);
      expect(reports.every((r) => !r.delivered)).toBe(true);
    }
    expect(h.adapter.sent.filter((s) => s.kind === "approval_buttons")).toHaveLength(0);
    // Each chat got the header and a pointer to the Mac: never the arguments, never buttons.
    const pointers = sentTexts(h).filter((t) => t.endsWith("Answer this on your Mac."));
    expect(pointers).toEqual([
      "Pay · financial\nAnswer this on your Mac.",
      "Fill credential · write\nAnswer this on your Mac.",
      "Run command on this Mac · write\nAnswer this on your Mac.",
      "Write file · destructive\nAnswer this on your Mac.",
    ]);
    for (const t of sentTexts(h)) {
      expect(t).not.toContain("alice@example.org");
      expect(t).not.toContain("/approve");
    }
  });

  it("device-only approvals cannot be answered from chat even by ref", async () => {
    const h = await harness({ capabilities: { buttons: false } });
    const issued = await h.broker.requestApproval(input({ kind: "credential_fill" }));
    const forced = {
      approval: { ...issued.approval, deviceOnly: false },
      answerTokens: { ...issued.answerTokens, [`telegram:${OWNER}`]: "tok" },
    };
    await h.service.deliverApproval(forced);
    h.clock.advance(1000);
    await h.adapter.receive({
      senderId: OWNER,
      text: `/approve ${approvalRef(issued.approval.id)} approve`,
    });
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
  });

  it("does not deliver to a surface whose peer is not an owner", async () => {
    const h = await harness();
    const issued = await h.broker.requestApproval(input({ surfaces: [`telegram:${FRIEND}`] }));
    expect(await h.service.deliverApproval(issued)).toEqual([
      { surface: `telegram:${FRIEND}`, delivered: false, reason: "no_owner_channel" },
    ]);
  });

  it("lists the owner's chat surfaces for the broker", async () => {
    const h = await harness({ ownerAllowFrom: ["telegram:777", "imessage:+15551234567"] });
    expect(h.service.ownerSurfaces().sort()).toEqual([`telegram:${OWNER}`, "telegram:777"]);
  });
});
