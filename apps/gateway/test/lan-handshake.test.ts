import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { openDb } from "@psyche/db";
import { parsePairingLinkAny } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { setupTokenHandlers } from "../src/compose/setup-tokens.ts";
import type { GatewayLimits } from "../src/context.ts";
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
afterEach(async () => {
  for (const c of open.splice(0)) c.close();
  await t?.cleanup();
});

async function freePort(): Promise<number> {
  const s: Server = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a handshake gets one answer per challenge", () => {
  it("spends the challenge on the first connect.verify: the rest are not verified at all", async () => {
    t = await startTestGateway();
    const c = await TestClient.open(`ws://127.0.0.1:${t.gateway.port}/ws`);
    open.push(c);
    const key = newDeviceKey();
    const res = await c.request("connect", {
      protocolVersion: { min: 1, max: 1 },
      deviceId: "pipelined",
      publicKey: key.publicKey,
      role: "client",
      platform: "macos",
      deviceFamily: "cli",
      name: "pipelined",
    });
    const nonce = (res.payload as { nonce: string }).nonce;
    // Twenty answers in one breath, all with a bad signature, as one burst of frames.
    for (let i = 0; i < 20; i++) {
      c.ws.send(
        JSON.stringify({
          type: "req",
          id: `v${i}`,
          method: "connect.verify",
          params: { nonce, signature: Buffer.alloc(64, i).toString("base64url") },
        }),
      );
    }
    await sleep(200);
    // Only the first was checked (and failed), so one failure is on the books: nine more are
    // needed to reach the limit of ten. Checking each of the twenty would have passed it long ago.
    const limiter = t.gateway.context.failedChallenges;
    for (let i = 0; i < 8; i++) limiter.record("127.0.0.1");
    expect(limiter.allowed("127.0.0.1")).toBe(true);
    limiter.record("127.0.0.1");
    expect(limiter.allowed("127.0.0.1")).toBe(false);
    expect(c.ws.readyState).toBeGreaterThanOrEqual(2);
  });

  it("closes the connection when the answer is refused for the rate limit, with no second try", async () => {
    t = await startTestGateway();
    for (let i = 0; i < 12; i++) t.gateway.context.failedChallenges.record("127.0.0.1");
    const c = await TestClient.open(`ws://127.0.0.1:${t.gateway.port}/ws`);
    open.push(c);
    const key = newDeviceKey();
    const res = await c.request("connect", {
      protocolVersion: { min: 1, max: 1 },
      deviceId: "limited",
      publicKey: key.publicKey,
      role: "client",
      platform: "macos",
      deviceFamily: "cli",
      name: "limited",
    });
    const nonce = (res.payload as { nonce: string }).nonce;
    const verify = { nonce, signature: Buffer.alloc(64, 1).toString("base64url") };
    const first = await c.request("connect.verify", verify);
    expect(first).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    await sleep(100);
    expect(c.ws.readyState).toBeGreaterThanOrEqual(2);
  });

  it("closes a connection that sends more handshake frames than a handshake needs", async () => {
    t = await startTestGateway();
    const c = await TestClient.open(`ws://127.0.0.1:${t.gateway.port}/ws`);
    open.push(c);
    for (let i = 0; i < 30; i++) {
      c.ws.send(JSON.stringify({ type: "req", id: `x${i}`, method: "connect.verify", params: {} }));
    }
    await sleep(200);
    expect(c.ws.readyState).toBeGreaterThanOrEqual(2);
  });
});

describe("a connection that is waiting for approval", () => {
  const KEY = newDeviceKey();
  const hello = (c: TestClient, deviceId: string) =>
    handshake(c, t.gateway.origin, { key: KEY, deviceId, deviceFamily: "cli" });

  it("is the only live one for its pairing request: a newer connection replaces the older", async () => {
    t = await startTestGateway();
    const sockets: TestClient[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await TestClient.open(`ws://127.0.0.1:${t.gateway.port}/ws`);
      open.push(c);
      sockets.push(c);
      const res = await hello(c, "same-device");
      expect(verified<{ phase?: string }>(res).phase).toBe("pending");
    }
    await sleep(100);
    expect(sockets.slice(0, 3).every((c) => c.ws.readyState >= 2)).toBe(true);
    expect(sockets[3]?.ws.readyState).toBe(1);
    // Another device's request is its own.
    const other = await TestClient.open(`ws://127.0.0.1:${t.gateway.port}/ws`);
    open.push(other);
    expect(verified<{ phase?: string }>(await hello(other, "another-device")).phase).toBe(
      "pending",
    );
    expect(sockets[3]?.ws.readyState).toBe(1);
  });

  it("may send only a handful of frames, and the refusal is logged once", async () => {
    const lines: string[] = [];
    t = await startTestGateway({
      logger: {
        log: (_level: string, msg: string, fields?: Record<string, unknown>) => {
          if (msg === "request failed") lines.push(String(fields?.code));
        },
      },
    });
    const c = await TestClient.open(`ws://127.0.0.1:${t.gateway.port}/ws`);
    open.push(c);
    expect(verified<{ phase?: string }>(await hello(c, "chatty")).phase).toBe("pending");
    for (let i = 0; i < 40; i++) {
      c.ws.send(JSON.stringify({ type: "req", id: `s${i}`, method: "settings.get", params: {} }));
    }
    await sleep(200);
    expect(c.ws.readyState).toBeGreaterThanOrEqual(2);
    expect(lines.filter((code) => code === "pairing_pending")).toHaveLength(1);
  });
});

describe("a challenge answered once is spent for good", () => {
  it("does not issue a new challenge after the answer, whatever it was", async () => {
    t = await startTestGateway();
    const c = await TestClient.open(`ws://127.0.0.1:${t.gateway.port}/ws`);
    open.push(c);
    const key = newDeviceKey();
    const params = {
      protocolVersion: { min: 1, max: 1 },
      deviceId: "spent",
      publicKey: key.publicKey,
      role: "client",
      platform: "macos",
      deviceFamily: "cli",
      name: "spent",
    };
    const first = await c.request("connect", params);
    const nonce = (first.payload as { nonce: string }).nonce;
    const seen: Record<string, unknown>[] = [];
    c.ws.on("message", (d) => seen.push(JSON.parse(d.toString()) as Record<string, unknown>));
    const send = (id: string, method: string, p: unknown) =>
      c.ws.send(JSON.stringify({ type: "req", id, method, params: p }));
    send("v", "connect.verify", { nonce, signature: Buffer.alloc(64, 1).toString("base64url") });
    send("c", "connect", params);
    send("v2", "connect.verify", { nonce, signature: Buffer.alloc(64, 2).toString("base64url") });
    await sleep(200);
    // No second challenge was issued, and the connection is gone.
    const challenges = seen.filter((f) => (f.payload as { nonce?: string } | undefined)?.nonce);
    expect(challenges).toEqual([]);
    expect(c.ws.readyState).toBeGreaterThanOrEqual(2);
  });
});

// A listener on `::1` as the stand-in for an IPv6 neighbour: its /64 is `0:0:0:0::/64`, its own
// address `::1`. (Its source is not unique-local, so the listener is told to admit it.)
const V4: LanInterface = {
  name: "lan0",
  address: "127.0.0.1",
  family: "IPv4",
  network: "127.0.0.0/8",
  isDefault: true,
};
const V6: LanInterface = {
  name: "lan0",
  address: "::1",
  family: "IPv6",
  network: "0:0:0:0:0:0:0:1/128",
  isDefault: false,
};

const hasIpv6 = await new Promise<boolean>((resolve) => {
  const s: Server = createServer();
  s.once("error", () => resolve(false));
  s.listen(0, "::1", () => s.close(() => resolve(true)));
});

describe.skipIf(!hasIpv6)(
  "over IPv6, a neighbour's /64 limits do not shut out a real pairing",
  () => {
    async function start(limits: Partial<GatewayLimits>) {
      const db = openDb(":memory:");
      t = await startTestGateway({
        db,
        limits,
        handlers: setupTokenHandlers({ db, audit: { append: async (e) => e as never } }),
        config: { publicOrigin: "https://studio-mac.tail1234.ts.net" },
        lan: {
          candidates: () => [V4, V6],
          hostLabel: () => "studio-mac",
          advertiser: null,
          allowPeer: () => true,
        },
      });
      const port = await freePort();
      await t.gateway.context.lan.apply(
        { enabled: true, interfaces: ["lan0"], port, ipv6: true },
        true,
      );
      return { port, origin: `https://[::1]:${port}` };
    }

    async function lan6(port: number): Promise<TestClient> {
      const ca = readFileSync(join(lanTlsDir(t.home), "cert.pem"), "utf8");
      const c = await TestClient.open(
        `wss://[::1]:${port}/ws`,
        {},
        { ca, checkServerIdentity: (() => undefined) as unknown as () => boolean },
      );
      open.push(c);
      return c;
    }

    async function token(): Promise<string> {
      const admin = await adminClient(t.gateway);
      open.push(admin);
      const res = await admin.request("devices.setupToken.create", {
        scopes: ["operator.read"],
        via: "lan",
      });
      const parsed = parsePairingLinkAny((res.payload as { link: string }).link);
      if (parsed.version !== 2) throw new Error("expected v2");
      return parsed.payload.setupToken;
    }

    it("lets a valid unused setup token through a failed-challenge limit that a neighbour filled", async () => {
      const { port, origin } = await start({
        failedChallengesPerMinute: 1000,
        failedChallengesPrefixPerMinute: 3,
      });
      const gatewayKey = t.gateway.context.identity.publicKey;
      const setupToken = await token();
      for (let i = 0; i < 4; i++) {
        await handshake(await lan6(port), origin, { gatewayKey, tamperSignature: true });
      }
      // The /64 is over its limit: a newcomer without a token is refused ...
      const stranger = await handshake(await lan6(port), origin, { gatewayKey });
      expect(stranger.verifyRes).toMatchObject({ ok: false, error: { code: "rate_limited" } });
      // ... and one that carries the token the owner made pairs.
      const paired = await handshake(await lan6(port), origin, { gatewayKey, setupToken });
      expect(verified<{ phase?: string }>(paired).phase).toBe("paired");
      // A token that is not valid gets no such pass.
      const bogus = await handshake(await lan6(port), origin, {
        gatewayKey,
        setupToken: `pst_${"B".repeat(43)}`,
      });
      expect(bogus.verifyRes).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    });

    it("limits pairing requests per address and per /64 as well as in all", async () => {
      const { port, origin } = await start({
        lanPairingsPerIpPerHour: 100,
        lanPairingsPerPrefixPerHour: 2,
        lanPairingsTotalPerHour: 100,
      });
      const gatewayKey = t.gateway.context.identity.publicKey;
      const outcomes: string[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await handshake(await lan6(port), origin, { gatewayKey });
        outcomes.push(
          res.verifyRes?.ok === true
            ? "ok"
            : String((res.verifyRes?.error as { code?: string } | undefined)?.code),
        );
      }
      // The address's own budget (100) is not what stopped the third: the /64's (2) was.
      expect(outcomes).toEqual(["ok", "ok", "rate_limited", "rate_limited"]);
    });
  },
);
