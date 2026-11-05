import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { openDb } from "@psyche/db";
import { parsePairingLinkAny } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { setupTokenHandlers } from "../src/compose/setup-tokens.ts";
import { lanTlsDir } from "../src/lan/cert.ts";
import type { LanInterface } from "../src/lan/interfaces.ts";
import {
  adminClient,
  handshake,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  verified,
} from "./helpers.ts";

let t: TestGateway;
const open: TestClient[] = [];
const IFACES: LanInterface[] = [
  { name: "lan0", address: "127.0.0.1", family: "IPv4", network: "127.0.0.0/8", isDefault: true },
];

async function freePort(): Promise<number> {
  const s: Server = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function start() {
  const db = openDb(":memory:");
  t = await startTestGateway({
    db,
    handlers: setupTokenHandlers({ db, audit: { append: async (e) => e as never } }),
    config: { publicOrigin: "https://studio-mac.tail1234.ts.net" },
    lan: { candidates: () => IFACES, hostLabel: () => "studio-mac", advertiser: null },
  });
  const port = await freePort();
  await t.gateway.context.lan.apply({ enabled: true, interfaces: ["lan0"], port }, true);
  return port;
}

async function lanClient(port: number): Promise<TestClient> {
  const ca = readFileSync(join(lanTlsDir(t.home), "cert.pem"), "utf8");
  const c = await TestClient.open(
    `wss://127.0.0.1:${port}/ws`,
    { host: `studio-mac.local:${port}` },
    { ca, checkServerIdentity: (() => undefined) as unknown as () => boolean },
  );
  open.push(c);
  return c;
}

async function make(via?: "lan") {
  const admin = await adminClient(t.gateway);
  open.push(admin);
  const res = await admin.request("devices.setupToken.create", {
    scopes: ["operator.read"],
    ...(via ? { via } : {}),
  });
  return res.payload as { link: string; setupToken: { id: string } };
}

afterEach(async () => {
  for (const c of open.splice(0)) c.close();
  await t?.cleanup();
});

describe("a neighbour's failed challenges do not lock out a paired device", () => {
  it("keeps refusing the unpaired, and lets a device that proves its paired key in", async () => {
    const port = await start();
    const parsed = parsePairingLinkAny((await make("lan")).link);
    if (parsed.version !== 2) throw new Error("expected v2");
    const origin = parsed.payload.gatewayUrl;
    const key = newDeviceKey();
    const paired = await handshake(await lanClient(port), origin, {
      key,
      deviceId: "owner-laptop",
      gatewayKey: parsed.payload.gatewayKey,
      setupToken: parsed.payload.setupToken,
    });
    expect(verified<{ phase?: string }>(paired).phase).toBe("paired");

    // A neighbour (same address, or the same /64 on IPv6) fails challenges until the limit trips.
    for (let i = 0; i < 12; i++) {
      await handshake(await lanClient(port), origin, {
        gatewayKey: parsed.payload.gatewayKey,
        tamperSignature: true,
      });
    }
    // An unpaired newcomer is now refused with the rate limit ...
    const stranger = await handshake(await lanClient(port), origin, {
      gatewayKey: parsed.payload.gatewayKey,
    });
    expect(stranger.verifyRes).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    // ... a bad signature is too, and does not get to count again ...
    const forged = await handshake(await lanClient(port), origin, {
      key,
      deviceId: "owner-laptop",
      gatewayKey: parsed.payload.gatewayKey,
      tamperSignature: true,
    });
    expect(forged.verifyRes).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    // ... but the owner's own device, signing with its paired key, is let in.
    const again = await handshake(await lanClient(port), origin, {
      key,
      deviceId: "owner-laptop",
      gatewayKey: parsed.payload.gatewayKey,
    });
    expect(verified<{ phase?: string }>(again).phase).toBe("paired");
  });
});

describe("replacing the LAN certificate voids the links made for it", () => {
  it("revokes live v2 tokens, leaves v1 tokens alone, and the old token pairs nobody", async () => {
    const port = await start();
    const v2 = await make("lan");
    const v1 = await make();
    const parsed = parsePairingLinkAny(v2.link);
    if (parsed.version !== 2) throw new Error("expected v2");
    await t.gateway.context.lan.rotateCert();
    const admin = await adminClient(t.gateway);
    open.push(admin);
    const list = (
      (await admin.request("devices.setupToken.list", {})).payload as {
        setupTokens: { id: string; status: string }[];
      }
    ).setupTokens;
    const status = (id: string) => list.find((s) => s.id === id)?.status;
    expect(status(v2.setupToken.id)).toBe("revoked");
    expect(status(v1.setupToken.id)).toBe("live");
    // Whoever kept the old link (and the old certificate) gets a plain refusal.
    const late = await handshake(await lanClient(port), parsed.payload.gatewayUrl, {
      gatewayKey: parsed.payload.gatewayKey,
      setupToken: parsed.payload.setupToken,
    });
    expect(verified<{ phase?: string }>(late).phase).toBe("denied");
  });
});
