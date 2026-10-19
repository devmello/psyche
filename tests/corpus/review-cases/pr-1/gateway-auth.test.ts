// S23 review cases for devmello/psyche#1 (S00 bootstrap): apps/gateway auth + protocol scopes.
// Tests marked "FINDING" fail on the PR head by design; "HELD" tests pass and guard regressions.
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Gateway, resolveConfig, startGateway } from "@psyche/gateway";
import {
  connectSigningPayload,
  isAdminSettingKey,
  PairingRequest,
  PROTOCOL_VERSION,
} from "@psyche/protocol";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Json = Record<string, any>;
const silent = { log() {} } as never;

function newKey(): { publicKey: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: String(publicKey.export({ format: "jwk" }).x), privateKey };
}

/** One request/response channel over either transport. */
interface Chan { request(method: string, params?: unknown): Promise<Json>; close(): void }

function wsChan(url: string, headers: Record<string, string> = {}): Promise<Chan> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const waiting = new Map<string, (f: Json) => void>();
    let n = 0;
    ws.on("message", (d) => { const f = JSON.parse(String(d)); if (f.type === "res") waiting.get(f.id)?.(f); });
    ws.once("unexpected-response", (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
    ws.once("open", () => resolve({
      request: (method, params) => new Promise((r) => { const id = `r${++n}`; waiting.set(id, r);
        ws.send(JSON.stringify({ type: "req", id, method, params })); }),
      close: () => ws.close(),
    }));
  });
}

function unixChan(path: string): Promise<Chan> {
  return new Promise((resolve, reject) => {
    const s = createConnection(path);
    const waiting = new Map<string, (f: Json) => void>();
    let buf = ""; let n = 0;
    s.setEncoding("utf8");
    s.on("data", (c: string) => { buf += c; let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { const f = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (f.type === "res") waiting.get(f.id)?.(f); } });
    s.once("error", reject);
    s.once("connect", () => resolve({
      request: (method, params) => new Promise((r) => { const id = `u${++n}`; waiting.set(id, r);
        s.write(`${JSON.stringify({ type: "req", id, method, params })}\n`); }),
      close: () => s.end(),
    }));
  });
}

async function handshake(c: Chan, serverOrigin: string, o: { deviceId?: string; key?: ReturnType<typeof newKey>;
  deviceFamily?: string; role?: "client" | "node"; handshakeSecret?: string } = {}) {
  const key = o.key ?? newKey();
  const deviceFamily = o.deviceFamily ?? "desktop";
  const ch = await c.request("connect", {
    protocolVersion: { min: 1, max: PROTOCOL_VERSION }, deviceId: o.deviceId ?? `dev-${Math.random()}`,
    publicKey: key.publicKey, role: o.role ?? "client", platform: "macos", deviceFamily, name: "Pranav's iPhone",
    ...(o.handshakeSecret ? { handshakeSecret: o.handshakeSecret } : {}),
  });
  const { nonce, protocolVersion } = ch.payload;
  const sig = sign(null, connectSigningPayload({ nonce, platform: "macos", deviceFamily, protocolVersion, serverOrigin }), key.privateKey);
  return (await c.request("connect.verify", { nonce, signature: sig.toString("base64url") })).payload as Json;
}

let gw: Gateway; let home: string;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "s23-gw-"));
  gw = await startGateway({ config: { home, port: 0, dbPath: ":memory:", webRoot: null }, env: {}, logger: silent });
});
afterEach(async () => { await gw.stop("test"); rmSync(home, { recursive: true, force: true }); });
const wsUrl = () => `${gw.origin.replace("http", "ws")}/ws`;

describe("PR-1-A FINDING: loopback auto-pairing trusts a bearer secret any same-user process can read (design-19)", () => {
  it("an arbitrary local process reading run/handshake.secret must not get operator.admin", async () => {
    const stolen = readFileSync(join(home, "run", "handshake.secret"), "utf8").trim(); // 0600, same user
    const c = await wsChan(wsUrl());                                                    // no Origin: a native process
    const res = await handshake(c, gw.origin, { handshakeSecret: stolen, deviceFamily: "desktop" });
    c.close();
    expect(res.phase).not.toBe("paired");                     // fails today: paired with all OPERATOR_SCOPES
    expect(res.scopes ?? []).not.toContain("operator.admin");
  });

  it("the node Unix socket must not accept a role:client desktop handshake", async () => {
    const stolen = readFileSync(join(home, "run", "handshake.secret"), "utf8").trim();
    const c = await unixChan(gw.config.nodeSocketPath);
    const res = await handshake(c, gw.origin, { handshakeSecret: stolen, deviceFamily: "desktop", role: "client" });
    c.close();
    expect(res.scopes ?? []).not.toContain("operator.admin");  // fails today
  });
});

describe("PR-1-B FINDING: a second key can take over a pending device id", () => {
  it("connect with an existing pending deviceId and a different key is refused, not re-issued", async () => {
    const a = await wsChan(wsUrl());
    const first = await handshake(a, gw.origin, { deviceId: "phone-1" });
    expect(first.phase).toBe("pending");
    const b = await wsChan(wsUrl());
    const second = await handshake(b, gw.origin, { deviceId: "phone-1" });   // attacker key, same id + name
    a.close(); b.close();
    expect(second.phase).toBe("denied");                      // fails today: new pending request for the attacker key
  });

  it("PairingRequest carries the key fingerprint the owner approves", () => {
    const fields = Object.keys((PairingRequest as unknown as { properties: object }).properties);
    expect(fields.some((f) => /fingerprint|publicKey/i.test(f))).toBe(true);   // fails today
  });
});

describe("PR-1-C FINDING: security settings outside ADMIN_SETTING_ROOTS are writable with operator.write", () => {
  // 05 §9 (owner identity, identity links, dmScope), §7.3 (auto-mode models), §11 (MCP, skills,
  // plugins, updates), §6 (real-Chrome debugging), §13 (VM shares, clipboard), §8 (memory filters), §14 (backup).
  it.each([
    "commands.ownerAllowFrom", "identityLinks", "session.dmScope", "mcp.servers", "connectors.google.actionMatrix",
    "skills.installPolicy", "plugins.enabled", "models.roles.primary", "updates.check", "browser.realChrome",
    "vm.shares", "vm.clipboard", "memory.sensitiveTopics", "backup.recipients",
  ])("%s requires operator.admin", (key) => {
    expect(isAdminSettingKey(key)).toBe(true);
  });
});

describe("HELD: Origin and bind checks", () => {
  it.each(["null", "", "http://evil.test:7979", "http://localhost:7979"])("WS upgrade with Origin %j → 403", async (o) => {
    await expect(wsChan(wsUrl(), { Origin: o })).rejects.toThrow(/403/);
  });
  it("same-origin browser connection is not auto-paired even with the secret", async () => {
    const stolen = readFileSync(join(home, "run", "handshake.secret"), "utf8").trim();
    const c = await wsChan(wsUrl(), { Origin: gw.origin });
    const res = await handshake(c, gw.origin, { handshakeSecret: stolen });
    c.close();
    expect(res.phase).toBe("pending");
  });
  it.each(["0.0.0.0", "::", "192.168.1.10", "::ffff:127.0.0.1", "127.0.0.2"])("refuses to bind %s", (host) => {
    expect(() => resolveConfig({ PSYCHE_HOST: host })).toThrow(/Refusing to bind/);
  });
  it("non-auth methods before pairing → not_paired", async () => {
    const c = await wsChan(wsUrl());
    const r = await c.request("settings.get", {});
    c.close();
    expect(r.error?.code).toBe("not_paired");
  });
});

describe("TODO for S01 (not implemented on the PR head)", () => {
  it.todo("nodes.invoke from an operator.write client cannot reach helper-internal capabilities (vault.unlock, keychain.*)");
  it.todo("nodes.invoke goes through PermissionBroker.decide with initiator=client and records a receipt");
  it.todo("devices.approve fails if the device's publicKey changed since the pairing request was created");
  it.todo("failed challenges are rate-limited to 10/minute/IP and pairing to 5/hour (05 §10)");
  it.todo("a `pending` connection is closed after PAIRING_TTL_MS");
});
