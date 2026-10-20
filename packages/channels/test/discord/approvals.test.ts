import { type ApprovalRequestInput, PsycheError } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness, OWNER, OWNER_DM, STRANGER, until } from "./helpers.ts";

function input(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    kind: "send_email",
    summary: 'Send "Re: invoice" to alice@example.org',
    details: { to: "alice@example.org", subject: "Re: invoice" },
    bindingHash: `sha256:${"a".repeat(64)}`,
    grantKey: "email.send:example.org",
    requestedBy: { runId: "run1", taskId: null, threadId: "t1" },
    sideEffect: "write",
    surfaces: ["desktop", `discord:${OWNER}`],
    taint: false,
    ...overrides,
  };
}

interface Button {
  label: string;
  custom_id: string;
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function cards(x: Harness) {
  return x.fake
    .calls("POST", `/channels/${OWNER_DM}/messages`)
    .map((c) => c.body as { content: string; components?: { components: Button[] }[] });
}

function click(x: Harness, customId: string, userId: string, id = "1100000000000000001") {
  x.fake.dispatch("INTERACTION_CREATE", {
    id,
    token: "interaction-token-secret",
    type: 3,
    channel_id: OWNER_DM,
    user: { id: userId },
    data: { custom_id: customId, component_type: 2 },
    message: { id: "800000000000000001", content: "card" },
  });
}

describe("Discord approval buttons", () => {
  it("sends the card with Approve / Deny; the owner's click acks the interaction and approves", async () => {
    h = await harness();
    const issued = await h.broker.requestApproval(input());
    expect(await h.service.deliverApproval(issued)).toEqual([
      { surface: `discord:${OWNER}`, delivered: true },
    ]);
    // The owner's user id opened the DM channel.
    expect(h.fake.calls("POST", "/users/@me/channels")).toHaveLength(1);
    const [card] = cards(h);
    expect(card?.content.split("\n")[0]).toBe("Send email · write");
    const buttons = card?.components?.[0]?.components ?? [];
    expect(buttons.map((b) => b.label)).toEqual(["Approve", "Deny"]);
    const token = issued.answerTokens[`discord:${OWNER}`] ?? "?";
    for (const b of buttons) {
      expect(b.custom_id).toMatch(/^a:[A-Za-z0-9_-]{12}:[yn]$/);
      expect(b.custom_id).not.toContain(token);
      expect(b.custom_id).not.toContain(issued.approval.id);
    }

    h.clock.advance(1000);
    click(h, buttons[0]?.custom_id ?? "", OWNER);
    await until(() => h?.fake.calls("POST", /^\/interactions\//).length === 1);
    const [ack] = h.fake.calls("POST", /^\/interactions\//);
    expect(ack?.path).toBe("/interactions/1100000000000000001/interaction-token-secret/callback");
    expect(ack?.body).toEqual({
      type: 7,
      data: { components: [], content: "card\n\nApproval sent." },
    });
    let decided = await h.broker.get(issued.approval.id);
    for (let i = 0; i < 200 && decided?.status !== "approved"; i++) {
      await new Promise((r) => setTimeout(r, 5));
      decided = await h.broker.get(issued.approval.id);
    }
    expect(decided?.status).toBe("approved");
    expect(decided?.decidedBy).toEqual({ channel: "discord", senderId: OWNER });
  });

  it("a non-owner's click is acknowledged but never answers the approval", async () => {
    h = await harness();
    const issued = await h.broker.requestApproval(input());
    await h.service.deliverApproval(issued);
    const deny = cards(h)[0]?.components?.[0]?.components[1]?.custom_id ?? "";
    h.clock.advance(1000);
    click(h, deny, STRANGER);
    await until(() => h?.fake.calls("POST", /^\/interactions\//).length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
    // A forged / unknown button gets an ephemeral "no longer valid".
    click(h, "a:AAAAAAAAAAAA:y", OWNER, "1100000000000000002");
    await until(() => h?.fake.calls("POST", /^\/interactions\//).length === 2);
    expect(h.fake.calls("POST", /^\/interactions\//)[1]?.body).toMatchObject({
      type: 4,
      data: { flags: 64 },
    });
  });

  it("a device-only approval gets no buttons and says to answer on the Mac", async () => {
    h = await harness();
    const issued = await h.broker.requestApproval(
      input({ kind: "purchase", sideEffect: "financial", summary: "Buy a laptop stand" }),
    );
    // The broker strips chat surfaces from it; force one in: the channel layer still refuses.
    const [report] = await h.service.deliverApproval({
      approval: { ...issued.approval, deviceOnly: true },
      answerTokens: { ...issued.answerTokens, [`discord:${OWNER}`]: "tok" },
    });
    expect(report?.delivered).toBe(false);
    const [card] = cards(h);
    expect(card?.content).toBe("Pay · financial\nAnswer this on your Mac.");
    expect(card?.components).toBeUndefined();
    const err = await h.adapter
      .sendApprovalButtons(OWNER, { ...issued.approval, deviceOnly: true }, "t")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PsycheError);
    expect((err as PsycheError).code).toBe("forbidden");
  });
});
