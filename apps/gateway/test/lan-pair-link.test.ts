import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { openDb } from "@psyche/db";
import {
  type DeviceScope,
  gatewaySigningPayload,
  lanCertSigningPayload,
  parsePairingLinkAny,
} from "@psyche/protocol";
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
const audited: { kind: string; data?: unknown }[] = [];
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

async function start(config: Record<string, unknown> = {}) {
  const db = openDb(":memory:");
  t = await startTestGateway({
    db,
    handlers: setupTokenHandlers({
      db,
      audit: {
        append: async (entry) => {
          audited.push(entry);
          return entry as never;
        },
      },
    }),
    config,
    lan: { candidates: () => IFACES, hostLabel: () => "studio-mac", advertiser: null },
  });
  return t;
}

type Made = {
  link: string;
  version?: number;
  gatewayUrl: string;
  setupToken: { id: string; scopes: DeviceScope[] };
};

async function make(params: Record<string, unknown>) {
  const admin = await adminClient(t.gateway);
  open.push(admin);
  return admin.request("devices.setupToken.create", { scopes: ["operator.read"], ...params });
}

afterEach(async () => {
  audited.length = 0;
  for (const c of open.splice(0)) c.close();
  await t?.cleanup();
});

describe("which link the Host makes", () => {
  it("makes v1 for an address (as before) and v2 only when the owner asks for the network", async () => {
    await start({ publicOrigin: "https://studio-mac.tail1234.ts.net" });
    const port = await freePort();
    await t.gateway.context.lan.apply({ enabled: true, interfaces: ["lan0"], port }, true);

    const address = (await make({})).payload as Made;
    expect(address.version).toBe(1);
    expect(parsePairingLinkAny(address.link).version).toBe(1);

    const lan = (await make({ via: "lan" })).payload as Made;
    expect(lan.version).toBe(2);
    const parsed = parsePairingLinkAny(lan.link);
    expect(parsed.version).toBe(2);
    if (parsed.version !== 2) throw new Error("unreachable");
    // The endpoint is the LAN origin (never the public one), and the pins are this Gateway's own.
    expect(parsed.payload.gatewayUrl).toBe(`https://studio-mac.local:${port}`);
    expect(parsed.payload.gatewayKey).toBe(t.gateway.context.identity.publicKey);
    expect(parsed.payload.certPin).toBe(t.gateway.context.lan.certSpki());
    expect(Object.keys(parsed.payload).sort()).toEqual([
      "certPin",
      "gatewayKey",
      "gatewayUrl",
      "hostName",
      "setupToken",
    ]);
    expect(audited.map((a) => (a.data as { linkVersion?: number }).linkVersion)).toEqual([1, 2]);
  });

  it("makes no network link while LAN listening is off, and none without a certificate", async () => {
    await start({ publicOrigin: "https://studio-mac.tail1234.ts.net" });
    expect(await make({ via: "lan" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    // Paused on another network: enabled, but not listening, so there is no certificate to pin.
    await t.gateway.context.lan.apply({ enabled: true, interfaces: ["lan0"], port: 1 });
    expect(await make({ via: "lan" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    // No token was left behind by the refusals.
    const admin = await adminClient(t.gateway);
    open.push(admin);
    expect(
      (await admin.call<{ setupTokens: unknown[] }>("devices.setupToken.list", {})).setupTokens,
    ).toEqual([]);
  });

  it("works with no public address at all: the network link does not need one", async () => {
    await start({});
    const port = await freePort();
    await t.gateway.context.lan.apply({ enabled: true, interfaces: ["lan0"], port }, true);
    expect(((await make({ via: "lan" })).payload as Made).version).toBe(2);
    expect(await make({})).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("is still Host-shell only: a paired device cannot ask for a network link", async () => {
    await start({});
    const port = await freePort();
    await t.gateway.context.lan.apply({ enabled: true, interfaces: ["lan0"], port }, true);
    const c = await TestClient.open(`ws://127.0.0.1:${t.gateway.port}/ws`);
    open.push(c);
    await handshake(c, t.gateway.origin, { handshakeSecret: t.gateway.handshakeSecret });
    expect(
      await c.request("devices.setupToken.create", { scopes: ["operator.read"], via: "lan" }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});

describe("pairing over the network with a v2 link's token", () => {
  async function lanClient(port: number): Promise<TestClient> {
    const ca = readFileSync(join(lanTlsDir(t.home), "cert.pem"), "utf8");
    // Dialed by address, but naming the Host's `.local` name the way a client that resolved it does.
    const c = await TestClient.open(
      `wss://127.0.0.1:${port}/ws`,
      { host: `studio-mac.local:${port}` },
      { ca, checkServerIdentity: (() => undefined) as unknown as () => boolean },
    );
    open.push(c);
    return c;
  }

  it("shows the pinned certificate and key, then pairs once, and never twice", async () => {
    await start({});
    const port = await freePort();
    await t.gateway.context.lan.apply({ enabled: true, interfaces: ["lan0"], port }, true);
    const made = (await make({ via: "lan" })).payload as Made;
    const parsed = parsePairingLinkAny(made.link);
    if (parsed.version !== 2) throw new Error("expected v2");
    const link = parsed.payload;
    const origin = link.gatewayUrl;

    // What the client checks before it sends the token: the certificate it was shown is the pin,
    // and the identity key from the link signed that certificate and this connection.
    const c = await lanClient(port);
    const key = newDeviceKey();
    const first = await c.request("connect", {
      protocolVersion: { min: 1, max: 1 },
      deviceId: "paired-by-link",
      publicKey: key.publicKey,
      role: "client",
      platform: "macos",
      deviceFamily: "desktop",
      name: "Studio MacBook",
    });
    const challenge = first.payload as Record<string, string>;
    expect(challenge.serverOrigin).toBe(origin);
    expect(challenge.lanCertSpki).toBe(link.certPin);
    const idKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: link.gatewayKey },
      format: "jwk",
    });
    const verifies = (payload: Uint8Array, signature: string) =>
      verify(null, payload, idKey, Buffer.from(signature, "base64url"));
    expect(
      verifies(
        gatewaySigningPayload({
          nonce: challenge.nonce as string,
          serverOrigin: origin,
          devicePublicKey: key.publicKey,
        }),
        challenge.gatewaySignature as string,
      ),
    ).toBe(true);
    expect(
      verifies(
        lanCertSigningPayload({
          nonce: challenge.nonce as string,
          serverOrigin: origin,
          devicePublicKey: key.publicKey,
          spki: link.certPin,
        }),
        challenge.lanCertSignature as string,
      ),
    ).toBe(true);
    c.close();

    // The token pairs a desktop that bound its connect to that key, at once, with the ticked scopes.
    const paired = await handshake(await lanClient(port), origin, {
      gatewayKey: link.gatewayKey,
      setupToken: parsed.payload.setupToken,
    });
    expect(verified<{ phase?: string; scopes?: string[] }>(paired)).toMatchObject({
      phase: "paired",
      scopes: ["operator.read"],
    });
    // Single use: the same token from another device is denied, never a pending request.
    const again = await handshake(await lanClient(port), origin, {
      gatewayKey: link.gatewayKey,
      setupToken: parsed.payload.setupToken,
    });
    expect(verified<{ phase?: string }>(again).phase).toBe("denied");
  });

  it("a rotated certificate no longer matches the link's pin, so the client would stop", async () => {
    await start({});
    const port = await freePort();
    await t.gateway.context.lan.apply({ enabled: true, interfaces: ["lan0"], port }, true);
    const made = (await make({ via: "lan" })).payload as Made;
    const parsed = parsePairingLinkAny(made.link);
    if (parsed.version !== 2) throw new Error("expected v2");
    await t.gateway.context.lan.rotateCert();
    const c = await lanClient(port);
    const res = await c.request("connect", {
      protocolVersion: { min: 1, max: 1 },
      deviceId: "late",
      publicKey: newDeviceKey().publicKey,
      role: "client",
      platform: "macos",
      deviceFamily: "desktop",
      name: "late",
    });
    const spki = (res.payload as { lanCertSpki?: string }).lanCertSpki;
    expect(spki).toBeTruthy();
    expect(spki).not.toBe(parsed.payload.certPin);
  });
});
