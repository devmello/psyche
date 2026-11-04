import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDevice, listPairingRequests } from "@psyche/db";
import { type AuditEntry, parsePairingLink, SETUP_TOKEN_TTL_MS } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import {
  adminClient,
  type TestClient as Client,
  handshake,
  ik,
  newDeviceKey,
  TestClient,
  wsUrlOf,
} from "./helpers.ts";

let home: string;
let composed: ComposedGateway | undefined;
const clients: Client[] = [];

async function compose(publicOrigin?: string): Promise<ComposedGateway> {
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    limits: { pairingsPerHour: 1000 },
    config: {
      home,
      port: 0,
      dbPath: join(home, "psyche.db"),
      webRoot: null,
      ...(publicOrigin ? { publicOrigin } : {}),
    },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  return composed;
}

async function admin(gw: ComposedGateway): Promise<Client> {
  const c = await adminClient(gw.gateway);
  clients.push(c);
  return c;
}

async function createLink(c: Client, params: Record<string, unknown> = {}) {
  return await c.call<{ link: string; expiresAt: string }>(
    "devices.pairing.createLink",
    params,
    ik(),
  );
}

/** A new device connecting from the link, as the phone or a remote desktop would. */
async function connectWith(gw: ComposedGateway, setupToken: string | undefined) {
  const c = await TestClient.open(wsUrlOf(gw.gateway));
  clients.push(c);
  const key = newDeviceKey();
  const deviceId = `new-${Math.random().toString(36).slice(2)}`;
  const res = await handshake(c, gw.gateway.origin, {
    key,
    deviceId,
    deviceFamily: "web",
    ...(setupToken === undefined ? {} : { setupToken }),
  });
  return { ...res, deviceId, phase: (res.verifyRes?.payload as { phase?: string })?.phase };
}

async function auditKinds(c: Client, kind: string): Promise<AuditEntry[]> {
  return (await c.call<{ entries: AuditEntry[] }>("audit.list", { kind })).entries;
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "psyche-pairlink-")));
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop();
  composed = undefined;
  await rm(home, { recursive: true, force: true });
});

describe("devices.pairing.createLink", () => {
  it("makes a link that round-trips to this Gateway's address, key and name", async () => {
    const gw = await compose("https://studio-mac.tail1234.ts.net");
    const a = await admin(gw);
    const { link, expiresAt } = await createLink(a);
    const parsed = parsePairingLink(link);
    expect(parsed.gatewayUrl).toBe("https://studio-mac.tail1234.ts.net");
    expect(parsed.gatewayIdentityKey).toBe(gw.gateway.context.identity.publicKey);
    expect(parsed.hostName.length).toBeGreaterThan(0);
    const ttl = new Date(expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(SETUP_TOKEN_TTL_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(SETUP_TOKEN_TTL_MS);
  });

  it("stores only a hash of the token and audits the creation without it", async () => {
    const gw = await compose("https://studio-mac.tail1234.ts.net");
    const a = await admin(gw);
    const { link } = await createLink(a);
    const { setupToken } = parsePairingLink(link);
    const rows = gw.db.sqlite.prepare("SELECT * FROM pairing_setup_tokens").all() as {
      token_hash: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(createHash("sha256").update(setupToken).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain(setupToken);
    const entries = await auditKinds(a, "pairing_link.created");
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain(setupToken);
  });

  it("does not keep a link in the idempotency table past the token's life", async () => {
    const gw = await compose("https://studio-mac.tail1234.ts.net");
    const a = await admin(gw);
    const { link } = await createLink(a);
    const stored = () =>
      gw.db.sqlite
        .prepare(
          "SELECT result FROM gateway_idempotency WHERE method = 'devices.pairing.createLink'",
        )
        .all() as { result: string }[];
    expect(JSON.stringify(stored())).toContain(link);
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    gw.db.sqlite
      .prepare(
        "UPDATE gateway_idempotency SET created_at = ? WHERE method = 'devices.pairing.createLink'",
      )
      .run(old);
    await createLink(a);
    expect(JSON.stringify(stored())).not.toContain(link);
    expect(stored()).toHaveLength(1);
  });

  it("needs an address: publicOrigin or an https gatewayUrl, never anything else", async () => {
    const gw = await compose();
    const a = await admin(gw);
    await expect(createLink(a)).rejects.toThrow(/invalid_params/);
    await expect(createLink(a, { gatewayUrl: "http://192.168.1.20:7979" })).rejects.toThrow(
      /invalid_params/,
    );
    await expect(createLink(a, { gatewayUrl: "https://a.ts.net/?x=1" })).rejects.toThrow(
      /invalid_params/,
    );
    const ok = await createLink(a, { gatewayUrl: "https://studio-mac.local:7979" });
    expect(parsePairingLink(ok.link).gatewayUrl).toBe("https://studio-mac.local:7979");
  });

  it("is admin-only", async () => {
    const gw = await compose("https://studio-mac.tail1234.ts.net");
    const nonAdmin = await TestClient.open(wsUrlOf(gw.gateway));
    clients.push(nonAdmin);
    // The desktop shell auto-pairs with read/write/approvals but never admin.
    const { desktopClient } = await import("./helpers.ts");
    const d = await desktopClient(gw.gateway);
    clients.push(d);
    await expect(createLink(d)).rejects.toThrow(/forbidden/);
  });
});

describe("connecting with a setup token", () => {
  it("creates a pending request marked expected via pairing link; the owner still approves", async () => {
    const gw = await compose("https://studio-mac.tail1234.ts.net");
    const a = await admin(gw);
    const { setupToken } = parsePairingLink((await createLink(a)).link);
    const r = await connectWith(gw, setupToken);
    expect(r.phase).toBe("pending");
    const pending = listPairingRequests(gw.db, { status: "pending" }).find(
      (p) => p.deviceId === r.deviceId,
    );
    expect(pending?.viaPairingLink).toBe(true);
    expect(pending?.display).toContain("expected via pairing link");
    // The token granted nothing: the device is unpaired and has no scopes.
    const device = getDevice(gw.db, r.deviceId);
    expect(device?.pairedAt).toBeNull();
    expect(device?.scopes).toEqual([]);
    const used = await auditKinds(a, "pairing_link.used");
    expect(used).toHaveLength(1);
    expect(JSON.stringify(used)).not.toContain(setupToken);
  });

  it("refuses a second use and audits the refusal", async () => {
    const gw = await compose("https://studio-mac.tail1234.ts.net");
    const a = await admin(gw);
    const { setupToken } = parsePairingLink((await createLink(a)).link);
    expect((await connectWith(gw, setupToken)).phase).toBe("pending");
    const second = await connectWith(gw, setupToken);
    expect(second.phase).toBe("denied");
    expect(getDevice(gw.db, second.deviceId)).toBeUndefined();
    const refused = await auditKinds(a, "pairing_link.refused");
    expect(refused.map((e) => (e.data as { reason: string }).reason)).toEqual(["used"]);
  });

  it("refuses a token older than 10 minutes", async () => {
    const gw = await compose("https://studio-mac.tail1234.ts.net");
    const a = await admin(gw);
    const { setupToken } = parsePairingLink((await createLink(a)).link);
    const past = new Date(Date.now() - 60_000).toISOString();
    gw.db.sqlite.prepare("UPDATE pairing_setup_tokens SET expires_at = ?").run(past);
    const r = await connectWith(gw, setupToken);
    expect(r.phase).toBe("denied");
    expect(getDevice(gw.db, r.deviceId)).toBeUndefined();
    const refused = await auditKinds(a, "pairing_link.refused");
    expect(refused.map((e) => (e.data as { reason: string }).reason)).toEqual(["expired"]);
  });

  it("refuses a token it never issued, with the same reply as an expired one", async () => {
    const gw = await compose("https://studio-mac.tail1234.ts.net");
    const a = await admin(gw);
    const { setupToken } = parsePairingLink((await createLink(a)).link);
    const past = new Date(Date.now() - 60_000).toISOString();
    gw.db.sqlite.prepare("UPDATE pairing_setup_tokens SET expires_at = ?").run(past);
    const expired = await connectWith(gw, setupToken);
    const unknown = await connectWith(gw, "A".repeat(43));
    expect(unknown.phase).toBe("denied");
    expect(unknown.verifyRes?.payload).toEqual(expired.verifyRes?.payload);
  });

  it("does not spend the token when the request is retried by the same device", async () => {
    const gw = await compose("https://studio-mac.tail1234.ts.net");
    const a = await admin(gw);
    const { setupToken } = parsePairingLink((await createLink(a)).link);
    const key = newDeviceKey();
    const deviceId = "retry-device";
    for (let i = 0; i < 2; i++) {
      const c = await TestClient.open(wsUrlOf(gw.gateway));
      clients.push(c);
      const r = await handshake(c, gw.gateway.origin, {
        key,
        deviceId,
        deviceFamily: "web",
        setupToken,
      });
      expect((r.verifyRes?.payload as { phase?: string } | undefined)?.phase).toBe("pending");
    }
    expect(await auditKinds(a, "pairing_link.used")).toHaveLength(1);
  });

  it("still pairs without a token exactly as before", async () => {
    const gw = await compose("https://studio-mac.tail1234.ts.net");
    const a = await admin(gw);
    const r = await connectWith(gw, undefined);
    expect(r.phase).toBe("pending");
    const pending = listPairingRequests(gw.db, { status: "pending" }).find(
      (p) => p.deviceId === r.deviceId,
    );
    expect(pending?.viaPairingLink).toBeUndefined();
    expect(pending?.display).not.toContain("pairing link");
    expect(await auditKinds(a, "pairing_link.used")).toHaveLength(0);
  });

  it("does not let a node use a link", async () => {
    const gw = await compose("https://studio-mac.tail1234.ts.net");
    const a = await admin(gw);
    const { setupToken } = parsePairingLink((await createLink(a)).link);
    const c = await TestClient.open(wsUrlOf(gw.gateway));
    clients.push(c);
    const r = await handshake(c, gw.gateway.origin, {
      role: "node",
      deviceFamily: "psyche-node",
      setupToken,
    });
    expect((r.verifyRes?.payload as { phase?: string } | undefined)?.phase).toBe("denied");
  });
});
