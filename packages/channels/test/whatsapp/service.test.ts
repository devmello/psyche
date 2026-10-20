import { FakePermissionBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  WHATSAPP_SERVICE_WINDOW_MS,
  WINDOW_CLOSED_TEXT,
} from "../../src/adapters/whatsapp/adapter.ts";
import { WHATSAPP_IDENTITY_STRENGTH } from "../../src/adapters/whatsapp/mapping.ts";
import { ChannelService } from "../../src/service.ts";
import { channelSettings, isWeakTransport, validateChannel } from "../../src/settings.ts";
import { MemoryChannelStore } from "../../src/store/memory.ts";
import {
  ACCESS,
  adapter,
  approvalInput,
  FakeGraph,
  FRIEND,
  harness,
  MEDIA_URL,
  nextWamid,
  OWNER,
  PHONE_ID,
  PSYCHE,
  STRANGER,
} from "./helpers.ts";

const MESSAGES_URL = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;

describe("WhatsApp identity", () => {
  it("is strong by default behind one constant, and WEAK_TRANSPORTS follows it", () => {
    expect(WHATSAPP_IDENTITY_STRENGTH).toBe("strong");
    expect(isWeakTransport("whatsapp")).toBe(WHATSAPP_IDENTITY_STRENGTH === "weak");
  });

  it("validates E.164 ids and account, and has its own default rate", () => {
    const base = new ChannelService({
      store: new MemoryChannelStore(),
      broker: new FakePermissionBroker(),
      sink: { deliver: async () => {} },
    }).newChannel("whatsapp", PSYCHE);
    expect(validateChannel({ ...base, ownerIds: ["15550001111"], allowFrom: [FRIEND] })).toEqual([
      "WhatsApp ids are E.164 phones: 15550001111",
    ]);
    expect(validateChannel({ ...base, account: "psyche" })).toHaveLength(1);
    expect(channelSettings(base).rateLimit).toEqual({
      perChatPerSec: 1,
      perChannelPerSec: 20,
      burst: 3,
    });
  });
});

describe("WhatsApp through the channel service", () => {
  it("routes the owner as the owner", async () => {
    const h = await harness();
    await h.text(OWNER, "what's on today?");
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.route).toMatchObject({
      role: "owner",
      provenance: "owner",
      senderId: OWNER,
      chatId: OWNER,
    });
  });

  it("an allowlisted non-owner is untrusted and chat-only", async () => {
    const h = await harness();
    await h.text(FRIEND, "hi!");
    expect(h.delivered[0]?.route).toMatchObject({
      role: "allowed",
      provenance: "untrusted",
      toolAllow: [],
      senderId: FRIEND,
    });
    expect(h.delivered[0]?.route.injectMemory).toBe(false);
  });

  it("an unknown sender gets a pairing code over Graph, and nothing else", async () => {
    const h = await harness();
    await h.text(STRANGER, "who is this?");
    expect(h.delivered).toEqual([]);
    const req = h.graph.requests.at(-1);
    expect(req).toMatchObject({ method: "POST", url: MESSAGES_URL, auth: `Bearer ${ACCESS}` });
    expect(req?.json).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: STRANGER.slice(1),
      type: "text",
      text: { body: expect.stringMatching(/pairing code is \w+/), preview_url: false },
    });
    const pending = await h.service.listPairings({ channelId: h.channel.id, status: "pending" });
    expect(pending.map((p) => p.senderId)).toEqual([STRANGER]);
  });

  it("owner pairs like Telegram: ownerIds alone grants no chat access, dmPolicy still applies", async () => {
    const pairing = await harness({ channel: { allowFrom: [] } });
    await pairing.text(OWNER, "hello?");
    expect(pairing.delivered).toEqual([]);
    expect(pairing.graph.texts().at(-1)).toMatch(/pairing code/);
    const [request] = await pairing.service.listPairings({
      channelId: pairing.channel.id,
      status: "pending",
    });
    expect(request?.senderId).toBe(OWNER);

    const allowlist = await harness({ channel: { allowFrom: [], dmPolicy: "allowlist" } });
    await allowlist.text(OWNER, "hello?");
    expect(allowlist.delivered).toEqual([]);
    expect(allowlist.graph.sends()).toEqual([]);
  });

  it("refuses free-form sends outside the 24-hour window, locally and from Graph 131047", async () => {
    const h = await harness();
    await expect(h.wa.send({ chatId: FRIEND, text: "unprompted" })).rejects.toMatchObject({
      code: "forbidden",
      message: WINDOW_CLOSED_TEXT,
    });
    await h.text(FRIEND, "hi");
    await h.wa.send({ chatId: FRIEND, text: "hello back", replyToMessageId: "wamid.IN1" });
    expect(h.graph.sends().at(-1)).toMatchObject({
      to: FRIEND.slice(1),
      text: { body: "hello back", preview_url: false },
      context: { message_id: "wamid.IN1" },
    });
    const before = h.graph.requests.length;
    h.clock.advance(WHATSAPP_SERVICE_WINDOW_MS);
    await expect(h.wa.send({ chatId: FRIEND, text: "late" })).rejects.toMatchObject({
      code: "forbidden",
      message: WINDOW_CLOSED_TEXT,
    });
    expect(h.graph.requests).toHaveLength(before);

    await h.text(FRIEND, "back again");
    h.graph.replies.push({
      status: 400,
      body: { error: { code: 131047, message: "Re-engagement message" } },
    });
    await expect(h.wa.send({ chatId: FRIEND, text: "x" })).rejects.toMatchObject({
      code: "forbidden",
      message: WINDOW_CLOSED_TEXT,
    });
    await expect(h.wa.send({ chatId: FRIEND, text: "x".repeat(4097) })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("maps 429 / 5xx to retryable errors and a bad token to a fatal health detail, never echoing it", async () => {
    const h = await harness();
    await h.text(FRIEND, "hi");
    const errors: unknown[] = [];
    const attempt = () => h.wa.send({ chatId: FRIEND, text: "hi" }).catch((e) => errors.push(e));
    h.graph.replies.push({
      status: 429,
      body: { error: { code: 130429, message: `slow down ${ACCESS}` } },
      headers: { "retry-after": "2" },
    });
    await attempt();
    h.graph.replies.push({ status: 503, body: "oops" });
    await attempt();
    expect(await h.wa.health()).toMatchObject({ ok: true });
    h.graph.replies.push({
      status: 401,
      body: { error: { code: 190, message: `Invalid OAuth access token ${ACCESS}` } },
    });
    await attempt();
    expect(errors).toMatchObject([
      { code: "rate_limited", retryable: true, details: { retryAfterSec: 2, graphCode: 130429 } },
      { code: "unavailable", retryable: true },
      { code: "unauthorized", retryable: false, message: "WhatsApp rejected the access token" },
    ]);
    expect(await h.wa.health()).toMatchObject({
      ok: false,
      detail: "WhatsApp rejected the access token",
    });
    const dump = JSON.stringify(
      errors.map((e) => ({ m: (e as Error).message, s: (e as Error).stack, e })),
    );
    expect(dump).not.toContain(ACCESS);
    // No retry loop: exactly one Graph call per attempt.
    expect(h.graph.sends()).toHaveLength(3);
  });
});

describe("WhatsApp approvals", () => {
  it("sends reply buttons with a nonce; the owner's press approves once, a non-owner's does nothing", async () => {
    const h = await harness();
    await h.text(OWNER, "go ahead and prepare it");
    await h.text(FRIEND, "hi");
    const issued = await h.broker.requestApproval(approvalInput());
    expect(await h.service.deliverApproval(issued)).toEqual([
      { surface: `whatsapp:${OWNER}`, delivered: true },
    ]);
    const card = h.graph.sends().at(-1) as {
      to: string;
      type: string;
      interactive: {
        type: string;
        body: { text: string };
        action: { buttons: { type: string; reply: { id: string; title: string } }[] };
      };
    };
    expect(card).toMatchObject({ to: OWNER.slice(1), type: "interactive" });
    expect(card.interactive.type).toBe("button");
    expect(card.interactive.body.text.length).toBeLessThanOrEqual(1024);
    const buttons = card.interactive.action.buttons;
    expect(buttons.map((b) => b.reply.title)).toEqual(["Approve", "Deny"]);
    const approveId = buttons[0]?.reply.id ?? "";
    expect(approveId).toMatch(/^apr:[A-Za-z0-9_-]+:approve$/);
    expect(buttons[1]?.reply.id).toBe(approveId.replace(/:approve$/, ":deny"));
    const raw = JSON.stringify(card);
    expect(raw).not.toContain(issued.answerTokens[`whatsapp:${OWNER}`] ?? "?");
    expect(raw).not.toContain(issued.approval.id);

    h.clock.advance(1000);
    const press = (from: string, id: string) =>
      h.post([
        {
          from: from.slice(1),
          id: nextWamid(),
          timestamp: String(Math.floor(h.clock.now() / 1000)),
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id, title: "Approve" } },
        },
      ]);
    // A non-owner pressing the same button id (a forwarded card): nothing happens.
    expect((await press(FRIEND, approveId)).status).toBe(200);
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
    // A forged nonce does nothing either.
    await press(OWNER, "apr:AAAAAAAAAAAAAAAA:approve");
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");

    await press(OWNER, approveId);
    const decided = await h.broker.get(issued.approval.id);
    expect(decided).toMatchObject({ status: "approved", scopeGranted: "once" });
    expect(decided?.decidedBy).toEqual({ channel: "whatsapp", senderId: OWNER });
    // A second press is a replay: still approved once, and nothing reached the agent as text.
    await press(OWNER, approveId);
    expect((await h.broker.get(issued.approval.id))?.status).toBe("approved");
    expect(h.delivered.map((d) => d.message.text)).toEqual(["go ahead and prepare it", "hi"]);
  });

  it("a device-only approval gets the header and 'Answer this on your Mac.' with no buttons", async () => {
    const h = await harness();
    await h.text(OWNER, "hi");
    const issued = await h.broker.requestApproval(
      approvalInput({ kind: "purchase", sideEffect: "financial", summary: "Buy a laptop stand" }),
    );
    await h.service.deliverApproval({
      approval: { ...issued.approval, deviceOnly: false },
      answerTokens: { ...issued.answerTokens, [`whatsapp:${OWNER}`]: "tok" },
    });
    const last = h.graph.sends().at(-1) as { type: string; text: { body: string } };
    expect(last.type).toBe("text");
    expect(last.text.body).toContain("Answer this on your Mac.");
    expect(last.text.body).not.toContain("laptop");
    expect(JSON.stringify(last)).not.toContain("interactive");
  });

  it("cannot be answered outside the 24-hour window", async () => {
    const h = await harness();
    const issued = await h.broker.requestApproval(approvalInput());
    expect(await h.service.deliverApproval(issued)).toEqual([
      { surface: `whatsapp:${OWNER}`, delivered: false, reason: "send_failed:forbidden" },
    ]);
    expect(h.graph.sends()).toEqual([]);
  });
});

describe("WhatsApp attachments", () => {
  it("downloads media by id with the bearer token only from the media host", async () => {
    const graph = new FakeGraph();
    const wa = adapter(graph);
    const meta = (id: string, url: string, size = 3) =>
      graph.routes.set(`https://graph.facebook.com/v21.0/${id}`, {
        status: 200,
        body: { url, mime_type: "image/jpeg", file_size: size, id },
      });
    meta("1001", MEDIA_URL);
    graph.routes.set(MEDIA_URL, { status: 200, body: new Uint8Array([1, 2, 3]) });
    expect(await wa.fetchAttachment("1001")).toEqual(new Uint8Array([1, 2, 3]));
    expect(graph.requests.map((r) => [r.url, r.auth])).toEqual([
      ["https://graph.facebook.com/v21.0/1001", `Bearer ${ACCESS}`],
      [MEDIA_URL, `Bearer ${ACCESS}`],
    ]);

    for (const [id, url] of [
      ["1002", "https://evil.example/steal"],
      ["1003", "http://lookaside.fbsbx.com/x"],
      ["1004", "https://lookaside.fbsbx.com.evil.example/x"],
      ["1005", "https://user:pw@lookaside.fbsbx.com/x"],
    ] as const) {
      meta(id, url);
      await expect(wa.fetchAttachment(id)).rejects.toMatchObject({ code: "forbidden" });
    }
    // A redirect off the media host is refused before anything is fetched there.
    const hop = "https://lookaside.fbsbx.com/hop";
    meta("1006", hop);
    graph.routes.set(hop, {
      status: 302,
      body: "",
      headers: { location: "https://evil.example/x" },
    });
    await expect(wa.fetchAttachment("1006")).rejects.toMatchObject({ code: "forbidden" });
    expect(graph.requests.some((r) => r.url.startsWith("https://evil.example"))).toBe(false);

    await expect(wa.fetchAttachment("../me")).rejects.toMatchObject({ code: "forbidden" });
    meta("1007", MEDIA_URL, 17 * 1024 * 1024);
    await expect(wa.fetchAttachment("1007")).rejects.toMatchObject({ code: "invalid_params" });
    graph.routes.set(MEDIA_URL, { status: 200, body: "x".repeat(100) });
    meta("1008", MEDIA_URL, 0);
    await expect(
      adapter(graph, { maxDownloadBytes: 10 }).fetchAttachment("1008"),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("ingests an inbound image through fetchAttachment", async () => {
    const h = await harness();
    h.graph.routes.set("https://graph.facebook.com/v21.0/5005", {
      status: 200,
      body: { url: MEDIA_URL, mime_type: "image/png", file_size: 4 },
    });
    h.graph.routes.set(MEDIA_URL, { status: 200, body: new Uint8Array([9, 9, 9, 9]) });
    await h.post([
      {
        from: OWNER.slice(1),
        id: nextWamid(),
        timestamp: String(Math.floor(h.clock.now() / 1000)),
        type: "image",
        image: { id: "5005", mime_type: "image/png", caption: "my receipt" },
      },
    ]);
    expect(h.delivered[0]?.message.attachments?.[0]).toMatchObject({ ref: "5005", kind: "image" });
    expect(h.graph.requests.some((r) => r.url === MEDIA_URL)).toBe(true);
  });
});
