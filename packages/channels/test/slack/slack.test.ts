import type { ApprovalRequestInput } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { mapMessageEvent, plainText } from "../../src/adapters/slack/index.ts";
import { validateChannel } from "../../src/settings.ts";
import { APP_TOKEN, BOT_TOKEN, BOT_USER } from "./fake-slack.ts";
import { FRIEND, type Harness, harness, OWNER, STRANGER } from "./helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.adapter.stop();
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
    surfaces: ["desktop", `slack:${OWNER}`],
    taint: false,
    ...overrides,
  };
}

describe("Slack Socket Mode connection", () => {
  it("authenticates with the bot token, connects with the app token and acks every envelope", async () => {
    h = await harness();
    expect(h.slack.calls.map((c) => [c.method, c.token])).toEqual([
      ["auth.test", BOT_TOKEN],
      ["apps.connections.open", APP_TOKEN],
    ]);
    expect(await h.adapter.health()).toMatchObject({ ok: true });
    const id = h.slack.dm(OWNER, "hello");
    await h.settle();
    expect(h.slack.acked()).toEqual([id]);
  });

  it("reconnects after a drop, and at once when Slack asks for a refresh", async () => {
    h = await harness();
    h.slack.socket.drop();
    await h.settle();
    expect(h.slack.sockets).toHaveLength(2);
    expect(h.sleeps).toEqual([1000]);
    h.slack.socket.push({ type: "disconnect", reason: "refresh_requested" });
    await h.settle();
    expect(h.slack.sockets).toHaveLength(3);
    expect(h.sleeps).toEqual([1000]);
    h.slack.dm(OWNER, "still here");
    await h.settle();
    expect(h.delivered.map((d) => d.message.text)).toEqual(["still here"]);
  });

  it("a rejected app token is fatal: health says so and nothing spins", async () => {
    h = await harness({ start: false });
    h.slack.override.set("apps.connections.open", () => ({
      body: { ok: false, error: "invalid_auth" },
    }));
    await h.service.start(h.channel.id);
    await h.settle();
    const health = await h.adapter.health();
    expect(health).toMatchObject({ ok: false, detail: "Slack rejected the token (invalid_auth)" });
    expect(h.sleeps).toEqual([]);
    expect(h.slack.calls.filter((c) => c.method === "apps.connections.open")).toHaveLength(1);
  });
});

describe("Slack inbound through the channel service", () => {
  it("routes the owner's DM, and an allowlisted sender as untrusted and chat-only", async () => {
    h = await harness({ channel: { allowFrom: [OWNER, FRIEND] } });
    h.slack.dm(OWNER, "remind me about <https://example.org|the invoice>");
    h.slack.dm(FRIEND, "hi <@UPSYCHE01>");
    await h.settle();
    const [owner, friend] = h.delivered;
    expect(owner?.message.text).toBe("remind me about the invoice (https://example.org)");
    expect(owner?.route).toMatchObject({ role: "owner", provenance: "owner", chatId: `D${OWNER}` });
    expect(friend?.route).toMatchObject({
      role: "allowed",
      provenance: "untrusted",
      toolAllow: [],
      injectMemory: false,
    });
    expect(friend?.taintSources).toEqual([
      { sourceKind: "channel_message", origin: `slack:D${FRIEND}`, sender: FRIEND },
    ]);
  });

  it("an unknown sender gets a pairing code in their DM and nothing reaches the agent", async () => {
    h = await harness();
    h.slack.dm(STRANGER, "let me in");
    await h.settle();
    expect(h.delivered).toEqual([]);
    const post = h.slack.posts().at(-1);
    expect(post?.channel).toBe(`D${STRANGER}`);
    expect(String(post?.text)).toMatch(/Your pairing code is [A-HJ-NP-Z2-9]{8}\./);
  });

  it("ignores Psyche's own and other bots' messages, maps edits, and needs a mention in channels", async () => {
    h = await harness({
      channel: { allowFrom: [OWNER, FRIEND], config: { groups: { C1: { requireMention: true } } } },
    });
    h.slack.dm(OWNER, "from a bot", { bot_id: "B9" });
    h.slack.dm(BOT_USER, "my own echo");
    h.slack.event({
      type: "message",
      subtype: "channel_join",
      channel: "C1",
      user: FRIEND,
      ts: "1.1",
    });
    h.slack.event({
      type: "message",
      channel: "C1",
      channel_type: "channel",
      user: FRIEND,
      text: "lunch?",
      ts: "2.1",
    });
    h.slack.event({
      type: "message",
      channel: "C1",
      channel_type: "channel",
      user: FRIEND,
      text: "<@UPSYCHE01> what's on today?",
      ts: "3.1",
    });
    h.slack.event({
      type: "message",
      subtype: "message_changed",
      channel: `D${OWNER}`,
      channel_type: "im",
      message: { type: "message", user: OWNER, text: "fixed typo", ts: "4.1" },
      event_ts: "4.2",
    });
    await h.settle();
    expect(h.delivered.map((d) => [d.kind, d.message.chatId, d.message.text]).sort()).toEqual([
      ["edit", `D${OWNER}`, "fixed typo"],
      ["message", "C1", "@UPSYCHE01 what's on today?"],
    ]);
    // The reply goes into a thread under the mention, not into the channel.
    await h.service.send({ channelId: h.channel.id, chatId: "C1" }, "Two meetings.");
    expect(h.slack.posts().at(-1)).toMatchObject({
      channel: "C1",
      thread_ts: "3.1",
      text: "Two meetings.",
    });
  });
});

describe("Slack approvals", () => {
  it("delivers a card with buttons to the owner's DM; the owner's click answers it once", async () => {
    h = await harness({ channel: { allowFrom: [OWNER, FRIEND] } });
    const issued = await h.broker.requestApproval(input());
    expect(await h.service.deliverApproval(issued)).toEqual([
      { surface: `slack:${OWNER}`, delivered: true },
    ]);
    expect(h.slack.calls.some((c) => c.method === "conversations.open")).toBe(true);
    const card = h.slack.posts().at(-1) as {
      channel: string;
      blocks: { type: string; elements?: { value: string; action_id: string }[] }[];
    };
    expect(card.channel).toBe(`D${OWNER}`);
    const actions = card.blocks.find((b) => b.type === "actions")?.elements ?? [];
    expect(actions.map((a) => a.action_id)).toEqual([
      "psyche_approval_approve",
      "psyche_approval_deny",
    ]);
    // The button carries a nonce, never the approval id or the answer token.
    const nonce = actions[0]?.value ?? "";
    expect(JSON.stringify(card)).not.toContain(issued.answerTokens[`slack:${OWNER}`] ?? "?");
    expect(JSON.stringify(card)).not.toContain(issued.approval.id);
    const ts = h.slack.calls.filter((c) => c.method === "chat.postMessage").length;

    h.clock.advance(1000);
    // A non-owner pressing it (e.g. a forwarded card) changes nothing.
    h.slack.click(FRIEND, `D${OWNER}`, `${ts}`, "psyche_approval_approve", nonce);
    await h.settle();
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");

    h.slack.click(OWNER, `D${OWNER}`, `${ts}`, "psyche_approval_approve", nonce);
    await h.settle();
    const decided = await h.broker.get(issued.approval.id);
    expect(decided).toMatchObject({ status: "approved", scopeGranted: "once" });
    expect(decided?.decidedBy).toEqual({ channel: "slack", senderId: OWNER });
    const update = h.slack.calls.filter((c) => c.method === "chat.update").at(-1)?.body;
    expect(JSON.stringify(update)).not.toContain("psyche_approval_approve");
  });

  it("a device-only approval shows only the header and 'Answer this on your Mac.', no buttons", async () => {
    h = await harness();
    const issued = await h.broker.requestApproval(
      input({ kind: "purchase", sideEffect: "financial", summary: "Buy a laptop stand" }),
    );
    // As if the broker had forgotten to strip the chat surface: the channel layer still refuses.
    await h.service.deliverApproval({
      approval: { ...issued.approval, deviceOnly: false },
      answerTokens: { ...issued.answerTokens, [`slack:${OWNER}`]: "tok" },
    });
    const post = h.slack.posts().at(-1);
    expect(String(post?.text)).toContain("Answer this on your Mac.");
    expect(String(post?.text)).not.toContain("laptop");
    expect(post?.blocks).toBeUndefined();
  });
});

describe("Slack attachments and errors", () => {
  it("downloads files with the bot token only from Slack's file host", async () => {
    h = await harness();
    h.slack.files.set("/F1/report.pdf", new Uint8Array([1, 2, 3]));
    await expect(
      h.adapter.fetchAttachment("https://files.example.test/F1/report.pdf"),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(h.adapter.fetchAttachment("https://evil.example/steal")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      h.adapter.fetchAttachment("http://files.example.test/F1/report.pdf"),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("never puts a token in an error, and maps 429 to rate_limited", async () => {
    h = await harness();
    h.slack.override.set("chat.postMessage", () => ({
      status: 429,
      body: { ok: false, error: "ratelimited" },
      headers: { "retry-after": "3" },
    }));
    const err = await h.adapter.send({ chatId: `D${OWNER}`, text: "hi" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "rate_limited", details: { retryAfterMs: 3000 } });
    h.slack.override.set("chat.postMessage", () => ({
      body: { ok: false, error: "channel_not_found" },
    }));
    const other = await h.adapter.send({ chatId: "C404", text: "hi" }).catch((e: unknown) => e);
    expect(String((other as Error).message)).toBe("Slack chat.postMessage: channel_not_found");
    expect(JSON.stringify(other)).not.toContain("SECRET");
  });
});

describe("Slack mapping and ids", () => {
  it("only structured mentions count, and ids are Slack user ids", () => {
    const me = { userId: BOT_USER };
    const at = (text: string) =>
      mapMessageEvent(
        { type: "message", channel: "C1", channel_type: "channel", user: FRIEND, text, ts: "1.1" },
        me,
        "acme",
        0,
      );
    expect(at("hey @psyche do it")?.mentioned).toBe(false);
    expect(at(`hey <@${BOT_USER}> do it`)?.mentioned).toBe(true);
    expect(plainText("a &lt;b&gt; &amp; <!here>")).toBe("a <b> & @here");
    expect(
      validateChannel({
        type: "slack",
        dmPolicy: "pairing",
        allowFrom: ["U1AB"],
        ownerIds: ["alice"],
        groupAllowFrom: [],
      } as never),
    ).toEqual(["Slack ids are user ids like U012ABCDEF: alice"]);
  });
});
