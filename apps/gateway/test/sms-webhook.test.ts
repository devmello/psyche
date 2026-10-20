import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { twilioSignature } from "@psyche/channels";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChannelsSetup,
  composeChannels,
  SMS_WEBHOOK_PATH,
  smsSetupFromEnv,
} from "../src/compose/channels.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** N9: the Twilio webhook route exists only when SMS is configured, and admits signed posts only. */

const SID = "AC_TEST_ACCOUNT_SID_NOT_REAL";
const TOKEN = "tok_gateway_sms_secret_0123456789";
const PSYCHE = "+15550009999";
const STRANGER = "+15550003333";
const PUBLIC_URL = "https://psyche.example.test/channels/sms/twilio";

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function boot(setup: ChannelsSetup) {
  home = mkdtempSync(join(tmpdir(), "psyche-sms-"));
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [(s) => composeChannels(s, { ...setup, healthIntervalMs: 0 })],
  });
  return composed.gateway;
}

function post(origin: string, fields: Record<string, string>, signature: string) {
  return fetch(`${origin}${SMS_WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("SMS webhook route (N9)", () => {
  it("is not mounted when SMS is not configured", async () => {
    const gw = await boot({});
    const res = await post(gw.origin, { AccountSid: SID }, "x");
    expect(res.status).toBe(405);
    expect(smsSetupFromEnv({}, () => "")).toBeUndefined();
  });

  it("pairs an unknown sender from a signed post and refuses a forged one", async () => {
    const sends: URLSearchParams[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      sends.push(new URLSearchParams(String(init?.body ?? "")));
      return new Response(JSON.stringify({ sid: "SM1" }), { status: 201 });
    }) as typeof fetch;
    const gw = await boot({
      sms: {
        accountSid: SID,
        authToken: { use: (fn) => fn(TOKEN) },
        from: PSYCHE,
        publicUrl: PUBLIC_URL,
        options: { fetch: fakeFetch },
      },
    });
    const owner = await adminClient(gw);
    clients.push(owner);
    await owner.call(
      "channels.configure",
      { type: "sms", account: PSYCHE, dmPolicy: "pairing", allowFrom: [] },
      ik(),
    );
    const fields = {
      AccountSid: SID,
      MessageSid: `SM${"1".repeat(32)}`,
      From: STRANGER,
      To: PSYCHE,
      Body: "hello?",
    };
    const forged = await post(
      gw.origin,
      fields,
      twilioSignature("guess", PUBLIC_URL, Object.entries(fields)),
    );
    expect(forged.status).toBe(403);

    const good = twilioSignature(TOKEN, PUBLIC_URL, Object.entries(fields));
    await vi.waitFor(async () => {
      const res = await post(gw.origin, fields, good);
      expect(res.status).not.toBe(503);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<Response/>");
    });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]?.get("To")).toBe(STRANGER);
    expect(sends[0]?.get("Body")).toMatch(/pairing code/);
    // Replayed: refused, nothing more sent.
    expect((await post(gw.origin, fields, good)).status).toBe(403);
  });

  it("reads the environment: all four or nothing, E.164 sender, https URL, token file", () => {
    const env = {
      PSYCHE_SMS_TWILIO_ACCOUNT_SID: SID,
      PSYCHE_SMS_TWILIO_AUTH_TOKEN_FILE: "/run/secrets/twilio",
      PSYCHE_SMS_FROM: PSYCHE,
      PSYCHE_SMS_PUBLIC_URL: PUBLIC_URL,
    };
    const setup = smsSetupFromEnv(env, () => `${TOKEN}\n`);
    expect(setup).toMatchObject({ accountSid: SID, from: PSYCHE, publicUrl: PUBLIC_URL });
    expect(JSON.stringify(setup)).not.toContain(TOKEN);
    expect(() => smsSetupFromEnv({ PSYCHE_SMS_FROM: PSYCHE }, () => "")).toThrow(
      /PSYCHE_SMS_TWILIO_ACCOUNT_SID/,
    );
    expect(() => smsSetupFromEnv({ ...env, PSYCHE_SMS_FROM: "5550009999" }, () => TOKEN)).toThrow(
      /E.164/,
    );
    expect(() =>
      smsSetupFromEnv({ ...env, PSYCHE_SMS_PUBLIC_URL: "http://x.test/" }, () => TOKEN),
    ).toThrow(/https/);
  });
});
