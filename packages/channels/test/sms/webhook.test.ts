import { createHmac } from "node:crypto";
import type { InboundMessage } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SMS_REPLAY_WINDOW_MS } from "../../src/adapters/sms/adapter.ts";
import { mapSms, twilioSignature } from "../../src/adapters/sms/mapping.ts";
import {
  adapter,
  FakeTwilio,
  FRIEND,
  inbound,
  PSYCHE,
  PUBLIC_URL,
  SID,
  signed,
} from "./helpers.ts";

let api: FakeTwilio;
beforeEach(async () => {
  api = await new FakeTwilio().listen();
});
afterEach(() => api.close());

async function started(clock = { now: () => 1_000 }) {
  const a = adapter(api, { clock });
  const got: InboundMessage[] = [];
  a.onInbound((m) => {
    got.push(m);
  });
  await a.start();
  return { a, got };
}

describe("X-Twilio-Signature", () => {
  it("matches the documented algorithm (Twilio's published vector)", () => {
    const params: [string, string][] = [
      ["To", "+18005551212"],
      ["CallSid", "CA1234567890ABCDE"],
      ["From", "+12349013030"],
      ["Digits", "1234"],
      ["Caller", "+12349013030"],
    ];
    const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const data = `${url}CallSidCA1234567890ABCDECaller+12349013030Digits1234From+12349013030To+18005551212`;
    const expected = createHmac("sha1", "12345").update(data).digest("base64");
    expect(expected).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
    expect(twilioSignature("12345", url, params)).toBe(expected);
  });
});

describe("SMS webhook", () => {
  it("accepts a signed message: empty TwiML, weak identity, E.164 chat", async () => {
    const { a, got } = await started();
    const res = await a.handleWebhook(signed(inbound({ Body: "  hi there " })));
    expect(res.status).toBe(200);
    expect(res.body).toContain("<Response/>");
    expect(res.headers["content-type"]).toContain("text/xml");
    await a.drain();
    expect(got).toEqual([
      expect.objectContaining({
        channel: "sms",
        account: PSYCHE,
        chatId: FRIEND,
        senderId: FRIEND,
        isGroup: false,
        text: "hi there",
        identityStrength: "weak",
      }),
    ]);
  });

  it("rejects a bad, missing or wrong-URL signature, the wrong account or number, and big bodies", async () => {
    const { a, got } = await started();
    const fields = inbound();
    const bad = signed(fields);
    bad.headers["x-twilio-signature"] = `x${bad.headers["x-twilio-signature"]?.slice(1)}`;
    const cases = [
      bad,
      { ...signed(fields), headers: {} },
      // Signed for the Host the request claims, not the configured public URL.
      signed(fields, { url: "https://attacker.example/channels/sms/twilio" }),
      signed(fields, { token: "another-token" }),
      signed(inbound({ AccountSid: "AC_other" })),
      signed(inbound({ To: "+15550004444" })),
      signed(inbound({ Body: "x".repeat(70_000) })),
    ];
    for (const req of cases) expect((await a.handleWebhook(req)).status).toBe(403);
    await a.drain();
    expect(got).toEqual([]);
  });

  it("says nothing on refusal (empty 403) and reports each refusal with the claimed sender", async () => {
    const rejected: { reason: string; claimedFrom: string }[] = [];
    const a = adapter(api, { clock: { now: () => 1_000 }, onRejected: (r) => rejected.push(r) });
    await a.start();
    const ok = signed(inbound());
    const unsigned = { ...signed(inbound()), headers: {} };
    const forged = signed(inbound(), { token: "guess" });
    const other = signed(inbound({ AccountSid: "AC_other" }));
    for (const req of [unsigned, forged, other]) {
      const res = await a.handleWebhook(req);
      expect(res).toEqual({ status: 403, headers: { "cache-control": "no-store" }, body: "" });
    }
    expect((await a.handleWebhook(ok)).status).toBe(200);
    expect((await a.handleWebhook(ok)).status).toBe(403);
    expect((await a.handleWebhook(signed(inbound({ Body: "x".repeat(70_000) })))).status).toBe(403);
    expect(rejected).toEqual([
      { reason: "unsigned", claimedFrom: FRIEND },
      { reason: "bad_signature", claimedFrom: FRIEND },
      { reason: "wrong_account", claimedFrom: FRIEND },
      { reason: "replayed", claimedFrom: FRIEND },
      { reason: "too_large", claimedFrom: "" },
    ]);
    await a.drain();
  });

  it("ignores X-Forwarded / Host headers for the signed URL", async () => {
    const { a } = await started();
    const fields = inbound();
    const req = signed(fields, { url: "https://evil.example/channels/sms/twilio" });
    req.headers.host = "evil.example";
    req.headers["x-forwarded-host"] = "evil.example";
    expect((await a.handleWebhook(req)).status).toBe(403);
  });

  it("rejects a replayed MessageSid for 24 hours", async () => {
    let now = 1_000;
    const { a, got } = await started({ now: () => now });
    const req = signed(inbound());
    expect((await a.handleWebhook(req)).status).toBe(200);
    expect((await a.handleWebhook(req)).status).toBe(403);
    now += SMS_REPLAY_WINDOW_MS - 1;
    expect((await a.handleWebhook(req)).status).toBe(403);
    await a.drain();
    expect(got).toHaveLength(1);
  });

  it("answers 503 until started (Twilio retries)", async () => {
    const a = adapter(api);
    expect((await a.handleWebhook(signed(inbound()))).status).toBe(503);
  });

  it("maps MMS media to attachment refs and drops opt-out keywords and short codes", () => {
    const msg = mapSms(
      Object.entries(
        inbound({
          Body: "",
          NumMedia: "2",
          MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/MM1/Media/ME1`,
          MediaContentType0: "image/jpeg",
          MediaUrl1: `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/MM1/Media/ME2`,
          MediaContentType1: "audio/amr",
        }),
      ),
      PSYCHE,
      0,
    );
    expect(msg?.attachments).toEqual([
      expect.objectContaining({
        kind: "image",
        mime: "image/jpeg",
        ref: expect.stringMatching(/ME1$/),
      }),
      expect.objectContaining({ kind: "audio", ref: expect.stringMatching(/ME2$/) }),
    ]);
    expect(mapSms(Object.entries(inbound({ Body: "STOP" })), PSYCHE, 0)).toBeUndefined();
    expect(
      mapSms(Object.entries(inbound({ OptOutType: "HELP", Body: "x" })), PSYCHE, 0),
    ).toBeUndefined();
    expect(mapSms(Object.entries(inbound({ From: "72345" })), PSYCHE, 0)).toBeUndefined();
  });

  it("uses the configured public URL with its query string", async () => {
    const url = `${PUBLIC_URL}?k=1`;
    const a = adapter(api, { publicUrl: url });
    await a.start();
    expect((await a.handleWebhook(signed(inbound(), { url }))).status).toBe(200);
    expect((await a.handleWebhook(signed(inbound()))).status).toBe(403);
  });
});
