import { createPublicKey, sign, verify, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { type NetworkInterfaceInfo, tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectSigningPayload,
  gatewaySigningPayload,
  lanCertSigningPayload,
  PROTOCOL_VERSION,
} from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLanCert, lanTlsDir, rotateLanCert, spkiPin } from "../src/lan/cert.ts";
import type { AdvertiseSpec, MdnsAdvertiser } from "../src/lan/discovery.ts";
import { buildLanTxt, withoutAddressRecords } from "../src/lan/discovery.ts";
import { type LanInterface, listLanInterfaces, resolveLanBinds } from "../src/lan/interfaces.ts";
import { sanitizeLabel } from "../src/lan/names.ts";
import { parseLanSettings } from "../src/lan/settings.ts";
import {
  adminClient,
  ik,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
} from "./helpers.ts";

const homes: string[] = [];
const gateways: TestGateway[] = [];
afterEach(async () => {
  for (const g of gateways.splice(0)) await g.cleanup();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), "psyche-lan-"));
  homes.push(h);
  return h;
}

async function freePort(): Promise<number> {
  const s: Server = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Tests bind loopback as the stand-in "LAN interface"; no real network interface is touched. */
const FAKE: LanInterface[] = [
  { name: "lan0", address: "127.0.0.1", isDefault: true },
  { name: "lan1", address: "192.0.2.77", isDefault: false },
];

function fakeAdvertiser(): {
  advertiser: MdnsAdvertiser;
  published: AdvertiseSpec[];
  stopped: number;
} {
  const state = { published: [] as AdvertiseSpec[], stopped: 0 };
  return {
    advertiser: {
      publish(spec) {
        state.published.push(spec);
        return {
          stop: async () => {
            state.stopped += 1;
          },
        };
      },
    },
    get published() {
      return state.published;
    },
    get stopped() {
      return state.stopped;
    },
  };
}

async function lanGateway(opts: { limits?: Record<string, number>; on?: boolean } = {}) {
  const ad = fakeAdvertiser();
  const port = await freePort();
  const g = await startTestGateway({
    lan: {
      candidates: () => FAKE,
      hostLabel: () => "studio-mac",
      advertiser: ad.advertiser,
      ...(opts.limits ? { limits: opts.limits } : {}),
    },
  });
  gateways.push(g);
  if (opts.on !== false) {
    const status = await g.gateway.context.lan.apply({
      enabled: true,
      interfaces: ["lan0"],
      port,
    });
    expect(status.listening).toEqual([{ address: "127.0.0.1", port }]);
  }
  return { g, ad, port };
}

function wssUrl(port: number): string {
  return `wss://127.0.0.1:${port}/ws`;
}

/** A test client that really validates the LAN certificate: it trusts only the Gateway's own. */
function openLan(g: TestGateway, port: number): Promise<TestClient> {
  const ca = readFileSync(join(lanTlsDir(g.home), "cert.pem"), "utf8");
  return TestClient.open(wssUrl(port), {}, { ca });
}

async function connectLan(client: TestClient, key = newDeviceKey(), family = "desktop") {
  const res = await client.request("connect", {
    protocolVersion: { min: 1, max: PROTOCOL_VERSION },
    deviceId: `lan-${Math.random().toString(36).slice(2)}`,
    publicKey: key.publicKey,
    role: "client",
    platform: "macos",
    deviceFamily: family,
    name: "lan device",
  });
  return { key, challenge: res.payload as Record<string, string> };
}

describe("LAN listening is off unless the owner turns it on", () => {
  it("binds nothing beyond loopback by default", async () => {
    const g = await startTestGateway({
      lan: { candidates: () => FAKE, hostLabel: () => "studio-mac", advertiser: null },
    });
    gateways.push(g);
    const status = g.gateway.context.lan.status();
    expect(status).toMatchObject({ enabled: false, listening: [], origin: null, certSpki: null });
    expect(g.gateway.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
    // No certificate material is made until the first enable.
    expect(() => statSync(lanTlsDir(g.home))).toThrow();
  });

  it("a refused wildcard never turns it on", () => {
    for (const bad of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]) {
      expect(() => parseLanSettings({ enabled: true, interfaces: [bad] })).toThrow(
        /every interface/,
      );
    }
    expect(() => parseLanSettings({ enabled: true, port: 0 })).toThrow();
    expect(() => parseLanSettings({ enabled: true, extra: 1 })).toThrow();
    expect(parseLanSettings(undefined).enabled).toBe(false);
    expect(parseLanSettings({}).enabled).toBe(false);
  });

  it("an owner choice with no usable interface binds nothing", async () => {
    const g = await startTestGateway({
      lan: { candidates: () => [], hostLabel: () => "studio-mac", advertiser: null },
    });
    gateways.push(g);
    const status = await g.gateway.context.lan.apply({ enabled: true, interfaces: [], port: 1 });
    expect(status.listening).toEqual([]);
    expect(status.problems).toContain("no_interface");
  });

  it("turning it off closes the socket", async () => {
    const { g, port } = await lanGateway();
    await g.gateway.context.lan.apply({ enabled: false });
    const c = await openLan(g, port).catch((e: Error) => e);
    expect(c).toBeInstanceOf(Error);
  });
});

describe("it binds only the interface the owner chose", () => {
  it("resolves the primary interface by default and an explicit name or address otherwise", () => {
    expect(resolveLanBinds([], FAKE).binds.map((b) => b.name)).toEqual(["lan0"]);
    expect(resolveLanBinds(["lan1"], FAKE).binds.map((b) => b.address)).toEqual(["192.0.2.77"]);
    expect(resolveLanBinds(["127.0.0.1"], FAKE).binds.map((b) => b.name)).toEqual(["lan0"]);
    expect(resolveLanBinds(["en9"], FAKE)).toEqual({ binds: [], unknown: ["en9"] });
  });

  it("never offers loopback, link-local, tunnels as the default or IPv6", () => {
    const info = (address: string, internal = false, family: "IPv4" | "IPv6" = "IPv4") =>
      ({
        address,
        netmask: "255.255.255.0",
        family,
        mac: "00:00:00:00:00:00",
        internal,
        cidr: `${address}/24`,
      }) as NetworkInterfaceInfo;
    const list = listLanInterfaces(() => ({
      lo0: [info("127.0.0.1", true)],
      utun3: [info("100.64.0.9")],
      en1: [info("169.254.4.4")],
      en0: [info("192.168.1.20"), info("fe80::1", false, "IPv6")],
    }));
    expect(list.map((i) => i.address)).toEqual(["192.168.1.20", "100.64.0.9"]);
    expect(list.find((i) => i.isDefault)?.name).toBe("en0");
  });

  it("binds exactly the chosen address, never a wildcard", async () => {
    const { g, port } = await lanGateway();
    const info = g.gateway.context.lan.status();
    expect(info.listening).toHaveLength(1);
    expect(info.listening[0]?.address).toBe("127.0.0.1");
    expect(info.listening[0]?.address).not.toMatch(/^(0\.0\.0\.0|::)$/);
    expect(info.port).toBe(port);
  });

  it("an unknown interface is reported and not guessed at", async () => {
    const g = await startTestGateway({
      lan: { candidates: () => FAKE, hostLabel: () => "studio-mac", advertiser: null },
    });
    gateways.push(g);
    const status = await g.gateway.context.lan.apply({
      enabled: true,
      interfaces: ["en9"],
      port: await freePort(),
    });
    expect(status.listening).toEqual([]);
    expect(status.problems).toContain("unknown_interface:en9");
  });

  it("the owner turns it on and off through settings.set and sees the result in gateway.info", async () => {
    const g = await startTestGateway({
      lan: { candidates: () => FAKE, hostLabel: () => "studio-mac", advertiser: null },
    });
    gateways.push(g);
    const admin = await adminClient(g.gateway);
    const port = await freePort();
    const bad = await admin.request(
      "settings.set",
      {
        key: "gateway.lan",
        value: { enabled: true, interfaces: ["0.0.0.0"], port },
      },
      ik(),
    );
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad.error)).toContain("every interface");
    const ok = await admin.request(
      "settings.set",
      { key: "gateway.lan", value: { enabled: true, interfaces: ["lan0"], port } },
      ik(),
    );
    expect(ok.ok).toBe(true);
    const info = await admin.request("gateway.info", {});
    const lan = (
      info.payload as { lan: { listening: unknown[]; origin: string; certSpki: string } }
    ).lan;
    expect(lan.listening).toEqual([{ address: "127.0.0.1", port }]);
    expect(lan.origin).toBe(`https://studio-mac.local:${port}`);
    const off = await admin.request(
      "settings.set",
      { key: "gateway.lan", value: { enabled: false } },
      ik(),
    );
    expect(off.ok).toBe(true);
    const after = await admin.request("gateway.info", {});
    expect((after.payload as { lan: { listening: unknown[] } }).lan.listening).toEqual([]);
    admin.close();
  });
});

describe("the self-signed certificate", () => {
  it("is generated on first enable with private permissions and the right names", async () => {
    const home = tempHome();
    const cert = await ensureLanCert(home, ["studio-mac.local", "192.168.1.20"]);
    const dir = lanTlsDir(home);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "key.pem")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "cert.pem")).mode & 0o777).toBe(0o600);
    expect(cert.names.sort()).toEqual(["192.168.1.20", "studio-mac.local"]);
    const x = new X509Certificate(cert.certPem);
    expect(x.subjectAltName).toContain("DNS:studio-mac.local");
    expect(x.subjectAltName).toContain("IP Address:192.168.1.20");
    expect(x.ca).toBe(false);
    expect(cert.spki).toBe(spkiPin(cert.certPem));
    expect(cert.spki).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("keeps the key (and so the pin) when only the addresses change, and when reloaded", async () => {
    const home = tempHome();
    const a = await ensureLanCert(home, ["studio-mac.local", "192.168.1.20"]);
    const same = await ensureLanCert(home, ["studio-mac.local", "192.168.1.20"]);
    expect(same.certPem).toBe(a.certPem);
    const moved = await ensureLanCert(home, ["studio-mac.local", "192.168.1.99"]);
    expect(moved.certPem).not.toBe(a.certPem);
    expect(moved.spki).toBe(a.spki);
    expect(moved.names).toContain("192.168.1.99");
  });

  it("rotates to a new key on request", async () => {
    const home = tempHome();
    const a = await ensureLanCert(home, ["studio-mac.local"]);
    const b = await rotateLanCert(home, ["studio-mac.local"]);
    expect(b.spki).not.toBe(a.spki);
    expect((await ensureLanCert(home, ["studio-mac.local"])).spki).toBe(b.spki);
    expect(statSync(join(lanTlsDir(home), "key.pem")).mode & 0o777).toBe(0o600);
  });

  it("refuses to replace a key file it cannot read", async () => {
    const home = tempHome();
    await ensureLanCert(home, ["studio-mac.local"]);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(lanTlsDir(home), "key.pem"), "garbage");
    await expect(ensureLanCert(home, ["studio-mac.local"])).rejects.toThrow(/refusing to replace/);
  });
});

describe("LAN peers are remote", () => {
  it("names the LAN origin and vouches for the certificate with the identity key", async () => {
    const { g, port } = await lanGateway();
    const c = await openLan(g, port);
    const { key, challenge } = await connectLan(c);
    // The Host header was 127.0.0.1:<port>, one of this Host's own LAN addresses.
    expect(challenge.serverOrigin).toBe(`https://127.0.0.1:${port}`);
    const gatewayKey = g.gateway.context.identity.publicKey;
    expect(challenge.gatewayKey).toBe(gatewayKey);
    const idKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: gatewayKey },
      format: "jwk",
    });
    expect(
      verify(
        null,
        gatewaySigningPayload({
          nonce: challenge.nonce as string,
          serverOrigin: challenge.serverOrigin as string,
          devicePublicKey: key.publicKey,
        }),
        idKey,
        Buffer.from(challenge.gatewaySignature as string, "base64url"),
      ),
    ).toBe(true);
    const spki = spkiPin(readFileSync(join(lanTlsDir(g.home), "cert.pem"), "utf8"));
    expect(challenge.lanCertSpki).toBe(spki);
    expect(
      verify(
        null,
        lanCertSigningPayload({
          nonce: challenge.nonce as string,
          serverOrigin: challenge.serverOrigin as string,
          devicePublicKey: key.publicKey,
          spki,
        }),
        idKey,
        Buffer.from(challenge.lanCertSignature as string, "base64url"),
      ),
    ).toBe(true);
    c.close();
  });

  it("names the .local origin when the client dials a name that is not one of ours", async () => {
    const { g, port } = await lanGateway();
    const ca = readFileSync(join(lanTlsDir(g.home), "cert.pem"), "utf8");
    // Same listener, but the Host header is not ours: the answer is still the .local origin.
    const c = await TestClient.open(wssUrl(port), { host: "evil.example" }, { ca });
    const { challenge } = await connectLan(c);
    expect(challenge.serverOrigin).toBe(`https://studio-mac.local:${port}`);
    c.close();
  });

  it("never auto-pairs or marks the desktop shell, even with the handshake secret from loopback", async () => {
    const { g, port } = await lanGateway();
    const c = await openLan(g, port);
    const key = newDeviceKey();
    const res = await c.request("connect", {
      protocolVersion: { min: 1, max: PROTOCOL_VERSION },
      deviceId: "lan-desktop",
      publicKey: key.publicKey,
      role: "client",
      platform: "macos",
      deviceFamily: "desktop",
      name: "lan desktop",
      handshakeSecret: g.gateway.handshakeSecret,
    });
    const ch = res.payload as {
      nonce: string;
      protocolVersion: number;
      serverOrigin: string;
      gatewayKey: string;
    };
    const payload = connectSigningPayload({
      gatewayKey: ch.gatewayKey,
      nonce: ch.nonce,
      platform: "macos",
      deviceFamily: "desktop",
      protocolVersion: ch.protocolVersion,
      serverOrigin: ch.serverOrigin,
    });
    const verified = await c.request("connect.verify", {
      nonce: ch.nonce,
      signature: sign(null, payload, key.privateKey).toString("base64url"),
      gatewayKey: ch.gatewayKey,
    });
    expect((verified.payload as { phase: string }).phase).toBe("pending");
    const conns = [...g.gateway.context.connections()];
    expect(conns.every((x) => x.identity?.desktopShell !== true)).toBe(true);
    const lanConn = conns.find((x) => x.peer.lan === true);
    expect(lanConn?.peer).toMatchObject({ remoteLoopback: false, lan: true, transport: "ws" });
    c.close();
  });

  it("requires the v2 key binding from a desktop on the LAN", async () => {
    const { g, port } = await lanGateway();
    const c = await openLan(g, port);
    const key = newDeviceKey();
    const res = await c.request("connect", {
      protocolVersion: { min: 1, max: PROTOCOL_VERSION },
      deviceId: "lan-v1",
      publicKey: key.publicKey,
      role: "client",
      platform: "macos",
      deviceFamily: "desktop",
      name: "lan desktop",
    });
    const ch = res.payload as { nonce: string; protocolVersion: number; serverOrigin: string };
    const payload = connectSigningPayload({
      nonce: ch.nonce,
      platform: "macos",
      deviceFamily: "desktop",
      protocolVersion: ch.protocolVersion,
      serverOrigin: ch.serverOrigin,
    });
    const verified = await c.request("connect.verify", {
      nonce: ch.nonce,
      signature: sign(null, payload, key.privateKey).toString("base64url"),
    });
    expect(verified.ok).toBe(false);
    c.close();
  });

  it("serves the health check and the WebSocket only", async () => {
    const { g, port } = await lanGateway();
    const ca = readFileSync(join(lanTlsDir(g.home), "cert.pem"), "utf8");
    const { request } = await import("node:https");
    const get = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path, ca, method: "GET" }, (res) => {
          let body = "";
          res.on("data", (d) => {
            body += d;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      });
    expect(await get("/healthz")).toEqual({ status: 200, body: '{"ok":true}' });
    expect((await get("/")).status).toBe(404);
    expect((await get("/version")).status).toBe(404);
    expect((await get("/api/anything")).status).toBe(404);
  });

  it("closes LAN connections when the certificate is rotated", async () => {
    const { g, port } = await lanGateway();
    const admin = await adminClient(g.gateway);
    const before = g.gateway.context.lan.status().certSpki;
    const res = await admin.request("gateway.lan.rotateCert", {}, ik());
    expect(res.ok).toBe(true);
    const after = (res.payload as { certSpki: string }).certSpki;
    expect(after).not.toBe(before);
    expect(g.gateway.context.lan.status().listening).toEqual([{ address: "127.0.0.1", port }]);
    admin.close();
  });
});

describe("rate limits hold on the LAN", () => {
  it("drops a neighbour over the concurrent-connection cap and over the per-minute rate", async () => {
    const { g, port } = await lanGateway({
      limits: { concurrentPerIp: 2, connectionsPerMinutePerIp: 4 },
    });
    const a = await openLan(g, port);
    const b = await openLan(g, port);
    await expect(openLan(g, port)).rejects.toThrow();
    a.close();
    b.close();
    await new Promise((r) => setTimeout(r, 50));
    // Two admitted so far in the window; a refused one is not counted. The limit is 4 a minute.
    const rest: (TestClient | Error)[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await openLan(g, port).catch((e: Error) => e);
      rest.push(c);
      if (c instanceof TestClient) c.close();
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(rest.map((x) => x instanceof Error)).toEqual([false, false, true]);
  });

  it("limits failed challenges per address like the loopback does", async () => {
    const { g, port } = await lanGateway({ limits: { concurrentPerIp: 64 } });
    const outcomes: boolean[] = [];
    for (let i = 0; i < 12; i++) {
      const c = await openLan(g, port);
      const { key, challenge } = await connectLan(c);
      const payload = connectSigningPayload({
        gatewayKey: challenge.gatewayKey as string,
        nonce: challenge.nonce as string,
        platform: "macos",
        deviceFamily: "desktop",
        protocolVersion: PROTOCOL_VERSION,
        serverOrigin: challenge.serverOrigin as string,
      });
      const sig = sign(null, payload, key.privateKey);
      sig[0] = (sig[0] ?? 0) ^ 0xff;
      const res = await c.request("connect.verify", {
        nonce: challenge.nonce,
        signature: sig.toString("base64url"),
        gatewayKey: challenge.gatewayKey,
      });
      outcomes.push((res.error as { code?: string } | undefined)?.code === "rate_limited");
      c.close();
    }
    expect(outcomes.slice(0, 10).some(Boolean)).toBe(false);
    expect(outcomes.slice(10).every(Boolean)).toBe(true);
  });
});

describe("the Bonjour record", () => {
  it("holds only the host name, the port and the key fingerprint", async () => {
    const { g, ad, port } = await lanGateway();
    expect(ad.published).toHaveLength(1);
    const spec = ad.published[0] as AdvertiseSpec;
    expect(spec).toMatchObject({
      name: "studio-mac",
      host: "studio-mac.local",
      port,
      interfaceAddress: "127.0.0.1",
    });
    expect(Object.keys(spec.txt).sort()).toEqual(["fp", "name", "v"]);
    expect(spec.txt.fp).toBe(g.gateway.context.identity.fingerprint.replace("sha256:", ""));
    const everything = JSON.stringify(spec);
    expect(everything).not.toContain(g.gateway.handshakeSecret);
    expect(everything).not.toContain(g.gateway.context.identity.publicKey);
    expect(everything).not.toContain(
      readFileSync(join(lanTlsDir(g.home), "key.pem"), "utf8").slice(30, 60),
    );
    await g.gateway.context.lan.apply({ enabled: false });
    expect(ad.stopped).toBe(1);
  });

  it("builds the same record from the pure builder, with a fixed set of keys", () => {
    const txt = buildLanTxt({ hostName: "studio-mac", fingerprint: `sha256:${"ab".repeat(32)}` });
    expect(txt).toEqual({ v: "1", name: "studio-mac", fp: "ab".repeat(32) });
  });

  it("publishes no address records: the system's own responder answers for the host name", () => {
    expect(
      withoutAddressRecords([
        { type: "PTR" },
        { type: "SRV" },
        { type: "TXT" },
        { type: "A" },
        { type: "AAAA" },
      ]).map((r) => r.type),
    ).toEqual(["PTR", "SRV", "TXT"]);
  });

  it("makes a DNS label from any host name", () => {
    expect(sanitizeLabel("Dev's MacBook Pro.local")).toBe("dev-s-macbook-pro");
    expect(sanitizeLabel("..")).toBe("psyche-host");
    expect(sanitizeLabel("a".repeat(90)).length).toBe(63);
  });
});
