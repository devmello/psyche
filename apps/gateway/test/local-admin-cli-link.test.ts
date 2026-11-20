import { createServer, type Server } from "node:net";
import { insertDevice, openDb, SETUP_TOKEN_SCOPES, updateDevice } from "@psyche/db";
import { type DeviceScope, parsePairingLinkAny, SETUP_TOKEN_TTL_MS } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { setupTokenHandlers } from "../src/compose/setup-tokens.ts";
import { isLocalAdminCli } from "../src/handlers/devices.ts";
import type { LanInterface } from "../src/lan/interfaces.ts";
import { resolvePeer, trustedProxyList } from "../src/proxy.ts";
import {
  handshake,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  verified,
  wsUrlOf,
} from "./helpers.ts";

// B2 (linux-helper-only design §7.3): an admin CLI device on the Host's loopback may make a
// pairing link. Each attack class the security review lists has a test here.

const publicOrigin = "https://lab-box.tail1234.ts.net";
const rebindOrigin = "http://rebind.attacker.example:7777";
const IFACES: LanInterface[] = [
  { name: "lan0", address: "127.0.0.1", family: "IPv4", network: "127.0.0.0/8", isDefault: true },
];
const SCOPES: DeviceScope[] = ["operator.read", "operator.write", "operator.approvals"];
const ADMIN: DeviceScope[] = [...SCOPES, "operator.admin"];

let t: TestGateway;
let clock = Date.parse("2026-11-19T12:00:00.000Z");
const open: TestClient[] = [];
const audited: { kind: string; data?: Record<string, unknown> }[] = [];

async function freePort(): Promise<number> {
  const s: Server = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function start() {
  const now = () => new Date(clock);
  const db = openDb(":memory:", { now: () => now().toISOString() });
  t = await startTestGateway({
    now,
    db,
    handlers: setupTokenHandlers({
      db,
      audit: {
        append: async (entry) => {
          audited.push(entry as never);
          return entry as never;
        },
      },
    }),
    config: { publicOrigin, allowedOrigins: [publicOrigin, rebindOrigin] },
    lan: { candidates: () => IFACES, hostLabel: () => "lab-box", advertiser: null },
  });
}

/**
 * A CLI device (`deviceFamily: cli`) with the given scopes: pairs once as the CLI does (pending),
 * the owner's approval is written directly, then it reconnects with `headers`.
 */
async function cli(
  scopes: DeviceScope[],
  headers: Record<string, string> = {},
  family = "cli",
): Promise<TestClient> {
  const key = newDeviceKey();
  const deviceId = `cli-${Math.random().toString(36).slice(2)}`;
  const first = await TestClient.open(wsUrlOf(t.gateway));
  await handshake(first, t.gateway.origin, { key, deviceId, deviceFamily: family });
  first.close();
  updateDevice(t.gateway.context.db, deviceId, { scopes, pairedAt: new Date(clock).toISOString() });
  const c = await TestClient.open(wsUrlOf(t.gateway), headers);
  open.push(c);
  const forwarded = Object.keys(headers).some((h) => /forwarded|real-ip/i.test(h));
  const res = await handshake(c, forwarded ? publicOrigin : t.gateway.origin, {
    key,
    deviceId,
    deviceFamily: family,
    ...(forwarded ? { gatewayKey: t.gateway.context.identity.publicKey } : {}),
  });
  expect(verified<{ phase?: string }>(res)?.phase).toBe("paired");
  return c;
}

const live = () =>
  t.gateway.context.db.sqlite
    .prepare("SELECT count(*) AS n FROM setup_tokens WHERE used_at IS NULL AND revoked_at IS NULL")
    .get() as { n: number };

const created = () => audited.filter((a) => a.kind === "device.setup_token.created");

afterEach(async () => {
  audited.length = 0;
  for (const c of open.splice(0)) c.close();
  await t?.cleanup();
});

describe("a local admin CLI makes links", () => {
  it("makes a v1 link, single use and ten minutes, and audits who made it", async () => {
    await start();
    const c = await cli(ADMIN);
    const made = await c.call<{
      link: string;
      version: number;
      setupToken: { expiresAt: string; scopes: DeviceScope[] };
    }>("devices.setupToken.create", { scopes: ADMIN });
    expect(made.version).toBe(1);
    expect(parsePairingLinkAny(made.link).version).toBe(1);
    expect(Date.parse(made.setupToken.expiresAt) - clock).toBe(SETUP_TOKEN_TTL_MS);
    expect(created()).toHaveLength(1);
    expect(created()[0]?.data).toMatchObject({ linkVersion: 1, madeBy: "local_admin_cli" });
    expect(JSON.stringify(audited)).not.toContain(made.link.split("token=")[1] ?? "no-token");
  });

  it("makes a v2 link when LAN is on, pinned to this Gateway's certificate", async () => {
    await start();
    const port = await freePort();
    await t.gateway.context.lan.apply({ enabled: true, interfaces: ["lan0"], port }, true);
    const c = await cli(ADMIN);
    const made = await c.call<{ link: string; version: number }>("devices.setupToken.create", {
      scopes: SCOPES,
      via: "lan",
    });
    expect(made.version).toBe(2);
    const parsed = parsePairingLinkAny(made.link);
    if (parsed.version !== 2) throw new Error("expected a v2 link");
    expect(parsed.payload.certPin).toBe(t.gateway.context.lan.certSpki());
    expect(parsed.payload.gatewayKey).toBe(t.gateway.context.identity.publicKey);
    expect(created()[0]?.data).toMatchObject({ linkVersion: 2, madeBy: "local_admin_cli" });
  });

  it("makes no v2 link while LAN is off", async () => {
    await start();
    const c = await cli(ADMIN);
    expect(
      await c.request("devices.setupToken.create", { scopes: SCOPES, via: "lan" }),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(live().n).toBe(0);
  });
});

describe("limits hold for the CLI path", () => {
  it("allows three live links and refuses a fourth, and a spent or expired one frees a slot", async () => {
    await start();
    const c = await cli(ADMIN);
    for (let i = 0; i < 3; i++) {
      expect((await c.request("devices.setupToken.create", { scopes: SCOPES })).ok).toBe(true);
    }
    const fourth = await c.request("devices.setupToken.create", { scopes: SCOPES });
    expect(fourth.ok).toBe(false);
    expect(live().n).toBe(3);
    expect(created()).toHaveLength(3);
    clock += SETUP_TOKEN_TTL_MS;
    expect((await c.request("devices.setupToken.create", { scopes: SCOPES })).ok).toBe(true);
  });

  it("a link expires at ten minutes (not a moment before)", async () => {
    await start();
    const c = await cli(ADMIN);
    const made = await c.call<{ setupToken: { expiresAt: string } }>("devices.setupToken.create", {
      scopes: SCOPES,
    });
    expect(Date.parse(made.setupToken.expiresAt)).toBe(clock + 10 * 60_000);
  });
});

describe("refusals", () => {
  const params = { scopes: SCOPES };
  const refusedWith = async (c: TestClient) => {
    const res = await c.request("devices.setupToken.create", params);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(live().n).toBe(0);
    expect(created()).toHaveLength(0);
  };

  it("refuses an admin CLI that arrived through any forwarding header", async () => {
    await start();
    for (const headers of [
      { "x-forwarded-for": "100.64.0.9" },
      { forwarded: "for=100.64.0.9" },
      { "x-real-ip": "100.64.0.9" },
      // Not on the old list: a proxy that sets only these still is a proxy.
      { "x-forwarded-host": "lab-box.tail1234.ts.net" },
      { "x-forwarded-proto": "https" },
    ]) {
      await refusedWith(await cli(ADMIN, headers));
    }
  });

  it("refuses a CLI that is not admin, however it connects", async () => {
    await start();
    await refusedWith(await cli(SCOPES));
    await refusedWith(await cli(["operator.read"]));
  });

  it("refuses an admin device that is not the CLI family", async () => {
    await start();
    await refusedWith(await cli(ADMIN, {}, "web"));
    await refusedWith(await cli(ADMIN, {}, "ios"));
  });

  it("refuses a page with an Origin, as a DNS-rebinding page has", async () => {
    await start();
    await refusedWith(await cli(ADMIN, { origin: rebindOrigin }));
  });

  it("a request cannot claim loopback, the CLI family or admin for itself", async () => {
    await start();
    const c = await cli(SCOPES);
    const res = await c.request("devices.setupToken.create", {
      ...params,
      local: true,
      desktopShell: true,
      deviceFamily: "cli",
      identity: { scopes: ADMIN },
      remoteLoopback: true,
    });
    expect(res).toMatchObject({ ok: false });
    expect(live().n).toBe(0);
  });

  it("an admin scope on a link needs an admin caller: a non-admin cannot mint one", async () => {
    await start();
    await refusedWith(await cli(SCOPES).then((c) => c));
    const res = await (await cli(SCOPES)).request("devices.setupToken.create", {
      scopes: ADMIN,
    });
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(SETUP_TOKEN_SCOPES).not.toContain("node");
  });

  it("a revoked CLI device cannot make a link", async () => {
    await start();
    const c = await cli(ADMIN);
    const admin = (t.gateway.context.db.sqlite
      .prepare("SELECT id FROM devices WHERE device_family = 'cli'")
      .get() ?? {}) as { id?: string };
    t.gateway.context.db.sqlite
      .prepare("UPDATE devices SET revoked_at = ? WHERE id = ?")
      .run(new Date(clock).toISOString(), admin.id);
    const res = await c.request("devices.setupToken.create", params).catch(() => ({ ok: false }));
    expect(res.ok).toBe(false);
    expect(live().n).toBe(0);
  });
});

describe("isLocalAdminCli (the predicate)", () => {
  const db = openDb(":memory:");
  const base = {
    transport: "ws" as const,
    remoteLoopback: true,
    remoteAddress: "127.0.0.1",
    origin: null,
  };
  const identity = { deviceId: "d1", scopes: ADMIN, role: "client" as const };
  insertDevice(db, {
    id: "d1",
    name: "cli",
    platform: "linux",
    role: "client",
    publicKey: Buffer.alloc(32, 1),
    scopes: ADMIN,
    pairedAt: "2026-11-19T00:00:00.000Z",
    deviceFamily: "cli",
  });

  it("accepts exactly the local admin CLI", () => {
    expect(isLocalAdminCli(db, identity, base)).toBe(true);
  });

  it.each([
    ["a non-loopback peer", { ...base, remoteLoopback: false, remoteAddress: "192.168.1.9" }],
    ["a LAN-listener peer", { ...base, lan: true as const }],
    ["a browser Origin", { ...base, origin: "http://rebind.attacker.example" }],
    ["a unix node socket", { ...base, transport: "unix" as const }],
    ["a relayed guest socket", { ...base, transport: "vm-relay" as const }],
    ["a container guest", { ...base, transport: "container-guest" as const }],
    ["a guest peer", { ...base, guest: { container: "c", redeem: () => false } }],
  ])("refuses %s", (_name, peer) => {
    expect(isLocalAdminCli(db, identity, peer as never)).toBe(false);
  });

  it("refuses a non-admin, a node role and an unknown device", () => {
    expect(isLocalAdminCli(db, { ...identity, scopes: SCOPES }, base)).toBe(false);
    expect(isLocalAdminCli(db, { ...identity, role: "node" }, base)).toBe(false);
    expect(isLocalAdminCli(db, { ...identity, deviceId: "nope" }, base)).toBe(false);
  });
});

describe("what makes a connection loopback (resolvePeer)", () => {
  const list = trustedProxyList(["127.0.0.1"]);
  const off = { enabled: false, trustedProxies: [] };
  const on = { enabled: true, trustedProxies: ["127.0.0.1"] };

  it.each([
    [{}, true],
    [{ "x-forwarded-for": "1.2.3.4" }, false],
    [{ forwarded: "for=1.2.3.4" }, false],
    [{ "x-real-ip": "1.2.3.4" }, false],
    [{ "x-forwarded-host": "evil.example" }, false],
    [{ "x-forwarded-proto": "https" }, false],
    [{ "x-forwarded-port": "443" }, false],
    [{ host: "localhost:7777", origin: "http://localhost:7777" }, true],
  ])("headers %j => loopback %s", (headers, loopback) => {
    for (const config of [off, on]) {
      expect(resolvePeer("127.0.0.1", headers, config, list).remoteLoopback).toBe(loopback);
      expect(resolvePeer("::ffff:127.0.0.1", headers, config, list).remoteLoopback).toBe(loopback);
    }
  });

  it("a non-loopback socket is never loopback, even with no headers", () => {
    expect(resolvePeer("192.168.1.9", {}, off, list).remoteLoopback).toBe(false);
    expect(resolvePeer("100.64.0.9", {}, on, list).remoteLoopback).toBe(false);
  });
});
