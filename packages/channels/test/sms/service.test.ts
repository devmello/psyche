import type { ApprovalRequestInput, Channel, PsycheError } from "@psyche/protocol";
import { FakeClock, FakePermissionBroker } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SmsAdapter } from "../../src/adapters/sms/adapter.ts";
import { approvalRef } from "../../src/format/approval-card.ts";
import type { ChannelInboundEvent } from "../../src/ports.ts";
import { ChannelService } from "../../src/service.ts";
import { validateChannel } from "../../src/settings.ts";
import { MemoryChannelStore } from "../../src/store/memory.ts";
import {
  adapter,
  FakeTwilio,
  FRIEND,
  inbound,
  OWNER,
  PSYCHE,
  SID,
  STRANGER,
  signed,
  TOKEN,
} from "./helpers.ts";

let api: FakeTwilio;
beforeEach(async () => {
  api = await new FakeTwilio().listen();
});
afterEach(() => api.close());

async function setup(options: { channel?: Partial<Channel>; admit?: () => boolean } = {}) {
  const clock = new FakeClock();
  const broker = new FakePermissionBroker({ clock });
  const delivered: ChannelInboundEvent[] = [];
  let n = 0;
  const service = new ChannelService({
    store: new MemoryChannelStore({ clock, newId: () => `id${++n}` }),
    broker,
    clock,
    sink: { deliver: async (e) => void delivered.push(e) },
    sleep: async (ms) => clock.advance(ms),
    random: () => 0.5,
    pairingRandom: () => 7,
    ...(options.admit === undefined ? {} : { admitInbound: options.admit }),
  });
  await service.init();
  const channel = await service.saveChannel({
    ...service.newChannel("sms", PSYCHE),
    dmPolicy: "pairing",
    ownerIds: [OWNER],
    allowFrom: [OWNER, FRIEND],
    ...options.channel,
  });
  const sms = adapter(api, { clock });
  service.attach(sms);
  await service.start(channel.id);
  const text = async (a: SmsAdapter, from: string, body: string) => {
    expect((await a.handleWebhook(signed(inbound({ From: from, Body: body })))).status).toBe(200);
    await a.drain();
  };
  return { clock, broker, service, channel, sms, delivered, text };
}

function approvalInput(): ApprovalRequestInput {
  return {
    kind: "send_email",
    summary: "Send an email to alice@example.org",
    details: { to: "alice@example.org", subject: "Re: invoice" },
    bindingHash: `sha256:${"a".repeat(64)}`,
    grantKey: "email.send:example.org",
    requestedBy: { runId: "run1", taskId: null, threadId: "t1" },
    sideEffect: "write",
    surfaces: ["desktop", `sms:${OWNER}`],
    taint: false,
  };
}

describe("SMS through the channel service", () => {
  it("the owner's own number is weak: never owner, a chat-only route", async () => {
    const h = await setup();
    await h.text(h.sms, OWNER, "hi, it's me");
    expect(h.delivered).toHaveLength(1);
    const route = h.delivered[0]?.route;
    expect(route).toMatchObject({ role: "allowed", provenance: "untrusted", toolAllow: [] });
    expect(route?.injectMemory).toBe(false);
    expect(route?.sessionKey).not.toBe("main");
    expect(
      h.service.isOwner(h.channel.id, { ...inbound(), identityStrength: "weak" } as never),
    ).toBe(false);
  });

  it("an allowlisted sender is chat-only (toolAllow [])", async () => {
    const h = await setup();
    await h.text(h.sms, FRIEND, "hello");
    expect(h.delivered[0]?.route).toMatchObject({
      role: "allowed",
      toolAllow: [],
      senderId: FRIEND,
    });
  });

  it("an unknown sender gets a pairing code through the Twilio REST API", async () => {
    const h = await setup();
    await h.text(h.sms, STRANGER, "who is this?");
    expect(h.delivered).toEqual([]);
    const req = api.requests.at(-1);
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe(`/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(req?.auth).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`);
    expect(req?.form.get("To")).toBe(STRANGER);
    expect(req?.form.get("From")).toBe(PSYCHE);
    expect(req?.form.get("Body")).toMatch(/pairing code is \w+/);
    const pending = await h.service.listPairings({ channelId: h.channel.id, status: "pending" });
    expect(pending.map((p) => p.senderId)).toEqual([STRANGER]);
  });

  it("inbound goes through admitInbound first", async () => {
    const h = await setup({ admit: () => false });
    await h.text(h.sms, STRANGER, "spam");
    expect(api.requests).toEqual([]);
    expect(h.delivered).toEqual([]);
  });

  it("chunks a long reply to 1600 characters", async () => {
    const h = await setup();
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`)
      .join(" ")
      .repeat(2);
    await h.service.send({ channelId: h.channel.id, chatId: FRIEND }, long, { format: "plain" });
    const bodies = api.sent();
    expect(bodies.length).toBeGreaterThan(1);
    for (const b of bodies) expect(b.length).toBeLessThanOrEqual(1600);
    await expect(h.sms.send({ chatId: FRIEND, text: "x".repeat(1601) })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("429 and 5xx are retryable; 21610 says the recipient unsubscribed; no secret in any error", async () => {
    const h = await setup();
    const errors: PsycheError[] = [];
    const attempt = async () => {
      try {
        await h.sms.send({ chatId: FRIEND, text: "hi" });
      } catch (e) {
        errors.push(e as PsycheError);
      }
    };
    api.replies.push({
      status: 429,
      body: { code: 20429, message: `slow down ${SID}` },
      headers: { "retry-after": "2" },
    });
    await attempt();
    api.replies.push({ status: 503, body: "oops" });
    await attempt();
    api.replies.push({
      status: 400,
      body: { code: 21610, message: `Attempt to send to unsubscribed recipient on ${SID}` },
    });
    await attempt();
    api.replies.push({ status: 401, body: { code: 20003, message: `Authenticate ${SID}` } });
    await attempt();
    expect(errors.map((e) => [e.code, e.retryable])).toEqual([
      ["rate_limited", true],
      ["unavailable", true],
      ["forbidden", false],
      ["unauthorized", false],
    ]);
    expect(errors[0]?.details).toMatchObject({ retryAfterSec: 2 });
    expect(errors[2]?.message).toMatch(/unsubscribed/);
    const dump = JSON.stringify(errors.map((e) => ({ m: e.message, d: e.details, s: e.stack })));
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(SID);
  });

  it("fetchAttachment refuses non-Twilio hosts and fetches from the API with basic auth", async () => {
    const h = await setup();
    for (const ref of [
      "https://evil.example/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1",
      "http://api.twilio.com/2010-04-01/Media/ME1",
      "https://api.twilio.com.evil.example/Media/ME1",
      "not a url",
    ]) {
      await expect(h.sms.fetchAttachment(ref)).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(api.requests).toEqual([]);
    api.replies.push({ status: 200, body: "jpegbytes" });
    const bytes = await h.sms.fetchAttachment(
      `${api.base}/2010-04-01/Accounts/${SID}/Messages/MM1/Media/ME1`,
    );
    expect(Buffer.from(bytes).toString()).toBe("jpegbytes");
    expect(api.requests[0]?.auth).toMatch(/^Basic /);
    api.replies.push({ status: 200, body: "x".repeat(100) });
    await expect(
      adapter(api, { maxDownloadBytes: 10 }).fetchAttachment(`${api.base}/Media/ME2`),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("never offers /approve over SMS, and /approve from the owner's number is refused", async () => {
    const h = await setup();
    const issued = await h.broker.requestApproval(approvalInput());
    expect(await h.service.deliverApproval(issued)).toEqual([
      { surface: `sms:${OWNER}`, delivered: false, reason: "weak_identity" },
    ]);
    const card = api.sent().at(-1) ?? "";
    expect(card).toContain("Answer this on your Mac.");
    expect(card).not.toContain("/approve");
    expect(card).not.toContain("alice@example.org");
    expect(card).not.toContain(issued.answerTokens[`sms:${OWNER}`] ?? "?");

    h.clock.advance(1000);
    await h.text(h.sms, OWNER, `/approve ${approvalRef(issued.approval.id)} approve`);
    expect((await h.broker.get(issued.approval.id))?.status).toBe("pending");
    expect(api.sent().at(-1)).toBe("Commands are only available to the owner.");
  });

  it("validates E.164 ids", () => {
    const base = {
      ...new ChannelService({
        store: new MemoryChannelStore(),
        broker: new FakePermissionBroker(),
        sink: { deliver: async () => {} },
      }).newChannel("sms", PSYCHE),
    };
    expect(validateChannel({ ...base, allowFrom: ["15550001111", "+15550002222"] })).toEqual([
      "SMS ids are E.164 phones: 15550001111",
    ]);
    expect(validateChannel({ ...base, account: "psyche" })).toHaveLength(1);
  });
});
