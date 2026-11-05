import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewaySigningPayload, PROTOCOL_VERSION } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import {
  identityFingerprint,
  identityKeyPath,
  loadOrCreateGatewayIdentity,
  rotateGatewayIdentity,
} from "../src/identity.ts";
import {
  expectPrivate,
  handshake,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  wsUrlOf,
} from "./helpers.ts";

const homes: string[] = [];
const gateways: TestGateway[] = [];
afterEach(async () => {
  for (const g of gateways.splice(0)) await g.cleanup();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), "psyche-identity-"));
  homes.push(h);
  return h;
}

describe("Gateway identity key", () => {
  it("is created at first start with private permissions and reloaded unchanged", () => {
    const home = tempHome();
    const first = loadOrCreateGatewayIdentity(home);
    const path = identityKeyPath(home);
    expectPrivate(path, 0o600);
    expectPrivate(join(home, "identity"), 0o700);
    const second = loadOrCreateGatewayIdentity(home);
    expect(second.publicKey).toBe(first.publicKey);
    expect(first.fingerprint).toBe(identityFingerprint(first.publicKey));
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("refuses to replace a file it cannot read: a silent new key would unpin every client", () => {
    const home = tempHome();
    loadOrCreateGatewayIdentity(home);
    writeFileSync(identityKeyPath(home), "not json");
    expect(() => loadOrCreateGatewayIdentity(home)).toThrow(/refusing to replace/);
    writeFileSync(identityKeyPath(home), JSON.stringify({ v: 2 }));
    expect(() => loadOrCreateGatewayIdentity(home)).toThrow(/refusing to replace/);
  });

  it("refuses a file whose public half is not the private key's", () => {
    const home = tempHome();
    const a = loadOrCreateGatewayIdentity(home);
    const file = JSON.parse(readFileSync(identityKeyPath(home), "utf8")) as {
      jwk: { x: string };
    };
    const other = newDeviceKey().publicKey;
    file.jwk.x = other;
    writeFileSync(identityKeyPath(home), JSON.stringify(file));
    expect(other).not.toBe(a.publicKey);
    expect(() => loadOrCreateGatewayIdentity(home)).toThrow(/does not match/);
  });

  it("rotates to a new key only on request", () => {
    const home = tempHome();
    const a = loadOrCreateGatewayIdentity(home);
    const b = rotateGatewayIdentity(home);
    expect(b.publicKey).not.toBe(a.publicKey);
    expect(loadOrCreateGatewayIdentity(home).publicKey).toBe(b.publicKey);
  });
});

function verifies(publicKey: string, payload: Uint8Array, signature: string): boolean {
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
  return verify(null, payload, key, Buffer.from(signature, "base64url"));
}

async function challengeFor(
  g: TestGateway,
  headers: Record<string, string>,
  devicePublicKey: string,
) {
  const client = await TestClient.open(wsUrlOf(g.gateway), headers);
  const res = await client.request("connect", {
    protocolVersion: { min: 1, max: PROTOCOL_VERSION },
    deviceId: `dev-${Math.random().toString(36).slice(2)}`,
    publicKey: devicePublicKey,
    role: "client",
    platform: "macos",
    deviceFamily: "desktop",
    name: "test device",
  });
  client.close();
  return res.payload as {
    nonce: string;
    serverOrigin: string;
    gatewayKey?: string;
    gatewaySignature?: string;
  };
}

describe("the challenge names and signs the Gateway's identity", () => {
  it("signs over this nonce, this origin and this device's key", async () => {
    const g = await startTestGateway();
    gateways.push(g);
    const key = newDeviceKey();
    const c = await challengeFor(g, {}, key.publicKey);
    expect(c.gatewayKey).toBe(g.gateway.context.identity.publicKey);
    expect(c.serverOrigin).toBe(g.gateway.origin);
    const payload = gatewaySigningPayload({
      nonce: c.nonce,
      serverOrigin: c.serverOrigin,
      devicePublicKey: key.publicKey,
    });
    expect(verifies(c.gatewayKey as string, payload, c.gatewaySignature as string)).toBe(true);
    // The same signature does not verify for another device key, another origin or another nonce.
    for (const other of [
      { devicePublicKey: newDeviceKey().publicKey },
      { serverOrigin: "https://evil.example" },
      { nonce: "A".repeat(43) },
    ]) {
      const changed = gatewaySigningPayload({
        nonce: c.nonce,
        serverOrigin: c.serverOrigin,
        devicePublicKey: key.publicKey,
        ...other,
      });
      expect(verifies(c.gatewayKey as string, changed, c.gatewaySignature as string)).toBe(false);
    }
  });

  it("tells a proxied connection the public origin and a direct one the loopback origin", async () => {
    const publicOrigin = "https://studio-mac.tail1234.ts.net";
    const g = await startTestGateway({ config: { publicOrigin, allowedOrigins: [publicOrigin] } });
    gateways.push(g);
    const direct = await challengeFor(g, {}, newDeviceKey().publicKey);
    expect(direct.serverOrigin).toBe(g.gateway.origin);
    const proxied = await challengeFor(
      g,
      { "x-forwarded-for": "100.64.0.9", "tailscale-user-login": "owner@example.com" },
      newDeviceKey().publicKey,
    );
    expect(proxied.serverOrigin).toBe(publicOrigin);
    // Both are signed by the same identity.
    expect(proxied.gatewayKey).toBe(direct.gatewayKey);
  });

  it("answers the same key after a restart on the same home", async () => {
    const home = tempHome();
    const first = await startTestGateway({ home });
    const key1 = first.gateway.context.identity.publicKey;
    await first.gateway.stop("test");
    const second = await startTestGateway({ home });
    gateways.push(second);
    expect(second.gateway.context.identity.publicKey).toBe(key1);
  });

  it("gateway.info gives the fingerprint and the Host's reachability to a paired reader only", async () => {
    const publicOrigin = "https://studio-mac.tail1234.ts.net";
    const g = await startTestGateway({ config: { publicOrigin, allowedOrigins: [publicOrigin] } });
    gateways.push(g);
    const unpaired = await TestClient.open(wsUrlOf(g.gateway));
    expect((await unpaired.request("gateway.info", {})).ok).toBe(false);
    unpaired.close();
    const client = await TestClient.open(wsUrlOf(g.gateway));
    const { verifyRes } = await handshake(client, g.gateway.origin, {
      handshakeSecret: g.gateway.handshakeSecret,
    });
    expect((verifyRes as { payload: { phase: string } }).payload.phase).toBe("paired");
    const info = await client.call<{
      identity: { publicKey: string; fingerprint: string };
      publicOrigin: string | null;
      trustedProxy: boolean;
    }>("gateway.info", {});
    const identity = g.gateway.context.identity;
    expect(info.identity).toEqual({
      publicKey: identity.publicKey,
      fingerprint: identityFingerprint(identity.publicKey),
    });
    expect(info.publicOrigin).toBe(publicOrigin);
    expect(info.trustedProxy).toBe(false);
    client.close();
  });
});

describe("psyched identity", () => {
  it("shows the fingerprint and rotates the key only on request", async () => {
    const home = tempHome();
    const before = process.env.PSYCHE_HOME;
    process.env.PSYCHE_HOME = home;
    try {
      const shown: string[] = [];
      expect(await runCli(["identity", "show"], (l) => shown.push(l))).toBe(0);
      const first = loadOrCreateGatewayIdentity(home);
      expect(shown).toEqual([first.fingerprint]);
      const rotated: string[] = [];
      expect(await runCli(["identity", "rotate"], (l) => rotated.push(l))).toBe(0);
      const second = loadOrCreateGatewayIdentity(home);
      expect(second.publicKey).not.toBe(first.publicKey);
      expect(rotated[0]).toBe(second.fingerprint);
      expect(rotated[1]).toMatch(/pair each computer again/);
    } finally {
      if (before === undefined) delete process.env.PSYCHE_HOME;
      else process.env.PSYCHE_HOME = before;
    }
  });
});

describe("/version", () => {
  it("stays unauthenticated and says only what connect already tells any caller", async () => {
    // remote-gateway design §6.3: the two numbers are also in protocol_version_mismatch, which any
    // client that can reach the Gateway gets, and clients need them before pairing to say "update
    // this app" or "update the Host". Nothing about the machine, its paths or its identity.
    const g = await startTestGateway();
    gateways.push(g);
    const res = await fetch(`${g.gateway.origin}/version`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["name", "protocolVersion", "version"]);
    expect(JSON.stringify(body)).not.toContain(g.home);
    expect(JSON.stringify(body)).not.toContain(g.gateway.context.identity.publicKey);
  });
});
