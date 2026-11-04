import { hashSetupToken, openDb } from "@psyche/db";
import {
  type DeviceScope,
  parsePairingLink,
  SETUP_TOKEN_PATTERN,
  SETUP_TOKEN_TTL_MS,
} from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { setupTokenHandlers, setupTokenUsedHook } from "../src/compose/setup-tokens.ts";
import {
  adminClient,
  handshake,
  ik,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  verified,
  wsUrlOf,
} from "./helpers.ts";

const publicOrigin = "https://studio-mac.tail1234.ts.net";
/** A request through Tailscale Serve: not loopback, so it is never auto-paired. */
const forwarded = { "x-forwarded-for": "100.64.0.9" };

let t: TestGateway;
const open: TestClient[] = [];
let clock = Date.parse("2026-11-04T12:00:00.000Z");

/** What the composition root would write to the audit log. */
const audited: { kind: string; data?: unknown }[] = [];

/** Set by a test to make the audit log refuse every append. */
let auditFails = false;

async function start(config: Record<string, unknown> = { publicOrigin }) {
  const now = () => new Date(clock);
  const db = openDb(":memory:", { now: () => now().toISOString() });
  t = await startTestGateway({
    now,
    db,
    handlers: setupTokenHandlers({
      db,
      audit: {
        append: async (entry) => {
          if (auditFails) throw new Error("audit disk full");
          audited.push(entry);
          return entry as never;
        },
      },
    }),
    config: { allowedOrigins: [publicOrigin], ...config },
  });
  return t;
}

async function client(headers: Record<string, string> = {}): Promise<TestClient> {
  const c = await TestClient.open(wsUrlOf(t.gateway), headers);
  open.push(c);
  return c;
}

type Made = {
  link: string;
  gatewayFingerprint: string;
  setupToken: { id: string; scopes: DeviceScope[]; status: string; expiresAt: string };
};

async function makeLink(scopes: DeviceScope[]): Promise<{ made: Made; token: string }> {
  const admin = await adminClient(t.gateway);
  open.push(admin);
  const made = await admin.call<Made>("devices.setupToken.create", { scopes });
  return { made, token: parsePairingLink(made.link).setupToken };
}

/** A remote desktop that verified the Gateway: binds its connect to the key, presents the token. */
async function pairWith(token: string | undefined, over: Parameters<typeof handshake>[2] = {}) {
  const res = await handshake(await client(forwarded), publicOrigin, {
    gatewayKey: t.gateway.context.identity.publicKey,
    ...(token === undefined ? {} : { setupToken: token }),
    ...over,
  });
  return res;
}

const phase = (r: Parameters<typeof verified>[0]) => verified<{ phase?: string }>(r)?.phase;

afterEach(async () => {
  audited.length = 0;
  auditFails = false;
  for (const c of open.splice(0)) c.close();
  await t?.cleanup();
});

describe("making a pairing link", () => {
  it("carries the origin, the key fingerprint, the token and the host name, and nothing else", async () => {
    await start();
    const { made, token } = await makeLink(["operator.read", "operator.write"]);
    const link = parsePairingLink(made.link);
    expect(Object.keys(link).sort()).toEqual([
      "gatewayFingerprint",
      "gatewayUrl",
      "hostName",
      "setupToken",
    ]);
    expect(link.gatewayUrl).toBe(publicOrigin);
    expect(link.gatewayFingerprint).toBe(t.gateway.context.identity.fingerprint);
    expect(token).toMatch(SETUP_TOKEN_PATTERN);
    expect(made.setupToken.status).toBe("live");
    expect(Date.parse(made.setupToken.expiresAt) - clock).toBe(SETUP_TOKEN_TTL_MS);
    // Only the hash is kept.
    const row = t.gateway.context.db.sqlite
      .prepare("SELECT token_hash FROM setup_tokens")
      .get() as { token_hash: string };
    expect(row.token_hash).toBe(hashSetupToken(token));
  });

  it("needs gateway.publicOrigin: without an address there is nothing to link to", async () => {
    await start({});
    const admin = await adminClient(t.gateway);
    open.push(admin);
    expect(
      await admin.request("devices.setupToken.create", { scopes: ["operator.read"] }),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("is an admin call, and never offers the node scope", async () => {
    await start();
    const c = await client();
    await handshake(c, t.gateway.origin, { handshakeSecret: t.gateway.handshakeSecret });
    expect(
      await c.request("devices.setupToken.create", { scopes: ["operator.read"] }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const admin = await adminClient(t.gateway);
    open.push(admin);
    expect(await admin.request("devices.setupToken.create", { scopes: ["node"] })).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    expect(await admin.request("devices.setupToken.create", { scopes: [] })).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
  });

  it("audits making and revoking a token without the token", async () => {
    await start();
    const { made, token } = await makeLink(["operator.read"]);
    const admin = await adminClient(t.gateway);
    open.push(admin);
    await admin.call("devices.setupToken.revoke", { id: made.setupToken.id }, ik());
    expect(audited.map((a) => a.kind)).toEqual([
      "device.setup_token.created",
      "device.setup_token.revoked",
    ]);
    expect(JSON.stringify(audited)).not.toContain(token);
  });

  it("lists tokens without the token, and revokes one", async () => {
    await start();
    const { made, token } = await makeLink(["operator.read"]);
    const admin = await adminClient(t.gateway);
    open.push(admin);
    const list = await admin.call<{ setupTokens: Made["setupToken"][] }>(
      "devices.setupToken.list",
      {},
    );
    expect(list.setupTokens.map((s) => s.id)).toEqual([made.setupToken.id]);
    expect(JSON.stringify(list)).not.toContain(token);
    const revoked = await admin.call<{ setupToken: { status: string } }>(
      "devices.setupToken.revoke",
      { id: made.setupToken.id },
      ik(),
    );
    expect(revoked.setupToken.status).toBe("revoked");
    const refused = await pairWith(token);
    expect(verified(refused)).toMatchObject({ phase: "denied", code: "setup_token_invalid" });
  });
});

describe("pairing with a setup token", () => {
  it("pairs at once with exactly the chosen scopes, and never admin unless chosen", async () => {
    await start();
    const { token } = await makeLink(["operator.read", "operator.approvals"]);
    const res = await pairWith(token);
    expect(verified(res)).toMatchObject({
      phase: "paired",
      scopes: ["operator.read", "operator.approvals"],
    });
    const devices = t.gateway.context.db.sqlite
      .prepare("SELECT scopes, paired_at FROM devices WHERE public_key = ?")
      .get(Buffer.from(res.key.publicKey, "base64url")) as { scopes: string; paired_at: string };
    expect(JSON.parse(devices.scopes)).toEqual(["operator.read", "operator.approvals"]);
    expect(devices.paired_at).not.toBeNull();
  });

  it("grants operator.admin only when the owner ticked it", async () => {
    await start();
    const withoutAdmin = await pairWith(
      (await makeLink(["operator.read", "operator.write"])).token,
    );
    expect((verified(withoutAdmin) as { scopes: string[] }).scopes).not.toContain("operator.admin");
    const withAdmin = await pairWith((await makeLink(["operator.read", "operator.admin"])).token);
    expect((verified(withAdmin) as { scopes: string[] }).scopes).toEqual([
      "operator.read",
      "operator.admin",
    ]);
  });

  it("announces the new computer to the Host's screens", async () => {
    await start();
    const admin = await adminClient(t.gateway);
    open.push(admin);
    const made = await admin.call<Made>("devices.setupToken.create", { scopes: ["operator.read"] });
    await pairWith(parsePairingLink(made.link).setupToken);
    await admin.waitForEvent((f) => f.event === "device.updated");
  });

  it("without a token still waits for the owner's approval", async () => {
    await start();
    expect(phase(await pairWith(undefined))).toBe("pending");
  });

  it("a token is single use, even from two connections at once", async () => {
    await start();
    const { token } = await makeLink(["operator.read", "operator.write"]);
    const [a, b] = await Promise.all([pairWith(token), pairWith(token)]);
    const phases = [phase(a), phase(b)].sort();
    expect(phases).toEqual(["denied", "paired"]);
    const loser = phase(a) === "denied" ? a : b;
    expect(verified(loser)).toMatchObject({ code: "setup_token_invalid" });
    expect((verified(loser) as { reason: string }).reason).toMatch(/already used|expired/);
    // And later: used is used.
    expect(verified(await pairWith(token))).toMatchObject({ code: "setup_token_invalid" });
  });

  it("refuses a token at ten minutes, and accepts it a moment before", async () => {
    await start();
    const early = await makeLink(["operator.read"]);
    const late = await makeLink(["operator.read"]);
    clock += SETUP_TOKEN_TTL_MS - 1;
    expect(phase(await pairWith(early.token))).toBe("paired");
    clock += 1;
    expect(verified(await pairWith(late.token))).toMatchObject({
      phase: "denied",
      code: "setup_token_invalid",
    });
  });

  it("refuses a token the Gateway never made", async () => {
    await start();
    const fake = `pst_${Buffer.alloc(32, 7).toString("base64url")}`;
    expect(verified(await pairWith(fake))).toMatchObject({
      phase: "denied",
      code: "setup_token_invalid",
    });
    // The refused device was not written.
    expect(
      t.gateway.context.db.sqlite.prepare("SELECT count(*) AS n FROM devices").get(),
    ).toMatchObject({ n: 0 });
  });

  it("is presented only by a client that verified the Gateway key (v2 connect)", async () => {
    await start();
    const { token } = await makeLink(["operator.read"]);
    const res = await handshake(await client(forwarded), publicOrigin, { setupToken: token });
    // A desktop over the network must bind its connect anyway; the connect itself is refused.
    expect(res.verifyRes?.ok).toBe(false);
    // A client that does not bind (the CLI over a tunnel) cannot use a token either.
    const cli = await handshake(await client(), t.gateway.origin, {
      setupToken: token,
      deviceFamily: "cli",
    });
    expect(verified(cli)).toMatchObject({ phase: "denied", code: "setup_token_invalid" });
    // The refused attempts did not spend it.
    expect(phase(await pairWith(token))).toBe("paired");
  });

  it("pairs the iPhone app (family ios) the same way, but never a page claiming to be it", async () => {
    await start();
    const { token } = await makeLink(["operator.read", "operator.write", "operator.approvals"]);
    const fake = await handshake(
      await client({ ...forwarded, origin: publicOrigin }),
      publicOrigin,
      { gatewayKey: t.gateway.context.identity.publicKey, setupToken: token, deviceFamily: "ios" },
    );
    expect(verified(fake)).toMatchObject({ phase: "denied", code: "setup_token_invalid" });
    const phone = await pairWith(token, { deviceFamily: "ios" });
    expect(verified(phone)).toMatchObject({
      phase: "paired",
      scopes: ["operator.read", "operator.write", "operator.approvals"],
    });
  });

  it("is never honoured for a node or for a browser page", async () => {
    await start();
    const { token } = await makeLink(["operator.read"]);
    const own = t.gateway.context.identity.publicKey;
    const node = await handshake(await client(forwarded), publicOrigin, {
      gatewayKey: own,
      setupToken: token,
      role: "node",
      deviceFamily: "psyche-node",
    });
    expect(verified(node)).toMatchObject({ phase: "denied", code: "setup_token_invalid" });
    const helper = await handshake(await client(forwarded), publicOrigin, {
      gatewayKey: own,
      setupToken: token,
      role: "node",
      deviceFamily: "mac-helper",
    });
    expect(helper.verifyRes?.ok === false || phase(helper) === "denied").toBe(true);
    const page = await handshake(
      await client({ ...forwarded, origin: publicOrigin }),
      publicOrigin,
      {
        gatewayKey: own,
        setupToken: token,
        deviceFamily: "web",
      },
    );
    expect(verified(page)).toMatchObject({ phase: "denied", code: "setup_token_invalid" });
    // None of that spent it.
    expect(phase(await pairWith(token))).toBe("paired");
  });

  it("only the Host's own desktop shell may make a link: a remote admin may not", async () => {
    await start();
    const adminLink = await makeLink(["operator.read", "operator.write", "operator.admin"]);
    const remote = await client(forwarded);
    const res = await handshake(remote, publicOrigin, {
      gatewayKey: t.gateway.context.identity.publicKey,
      setupToken: adminLink.token,
    });
    expect((verified(res) as { scopes: string[] }).scopes).toContain("operator.admin");
    expect(
      await remote.request("devices.setupToken.create", { scopes: ["operator.read"] }),
    ).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    // Nor can it be done by an admin that only arrived over the loopback without the secret.
    expect(
      t.gateway.context.db.sqlite.prepare("SELECT count(*) AS n FROM setup_tokens").get(),
    ).toMatchObject({ n: 1 });
  });

  it("a stale pending card cannot later widen the scopes a token chose", async () => {
    await start();
    const key = newDeviceKey();
    const deviceId = "remote-desktop-3";
    const waiting = await pairWith(undefined, { key, deviceId });
    expect(phase(waiting)).toBe("pending");
    const { token } = await makeLink(["operator.read"]);
    expect(phase(await pairWith(token, { key, deviceId }))).toBe("paired");
    const pending = t.gateway.context.db.sqlite
      .prepare("SELECT status FROM pairing_requests WHERE device_id = ?")
      .all(deviceId) as { status: string }[];
    expect(pending.map((p) => p.status)).toEqual(["expired"]);
  });

  it("is spent by a device that is already paired, which keeps its own scopes", async () => {
    await start();
    const first = await makeLink(["operator.read"]);
    const key = newDeviceKey();
    const deviceId = "remote-desktop-1";
    expect(phase(await pairWith(first.token, { key, deviceId }))).toBe("paired");
    const second = await makeLink(["operator.read", "operator.write", "operator.admin"]);
    const again = await pairWith(second.token, { key, deviceId });
    expect(verified(again)).toMatchObject({ phase: "paired", scopes: ["operator.read"] });
    // The link was used all the same: it cannot be used again by anyone.
    expect(verified(await pairWith(second.token))).toMatchObject({ code: "setup_token_invalid" });
  });

  it("does not let a token take over a device id that is paired with another key", async () => {
    await start();
    const first = await makeLink(["operator.read"]);
    const deviceId = "remote-desktop-2";
    expect(phase(await pairWith(first.token, { deviceId }))).toBe("paired");
    const second = await makeLink(["operator.read"]);
    const thief = await pairWith(second.token, { deviceId });
    expect(verified(thief)).toMatchObject({ phase: "denied", reason: "device key mismatch" });
    expect(phase(await pairWith(second.token))).toBe("paired");
  });
});

describe("when the device that made a link is revoked", () => {
  it("its unused link stops working, and a used one keeps its device", async () => {
    await start();
    const unused = await makeLink(["operator.read"]);
    const creator = (
      t.gateway.context.db.sqlite
        .prepare("SELECT created_by_device_id AS id FROM setup_tokens")
        .get() as { id: string }
    ).id;
    const other = await adminClient(t.gateway);
    open.push(other);
    await other.call("devices.revoke", { deviceId: creator });

    const refused = await pairWith(unused.token);
    expect(verified(refused)).toMatchObject({ phase: "denied", code: "setup_token_invalid" });
    const list = await other.call<{ setupTokens: { status: string }[] }>(
      "devices.setupToken.list",
      {},
    );
    expect(list.setupTokens.map((s) => s.status)).toEqual(["revoked"]);
  });
});

describe("when the audit log cannot be written", () => {
  it("withholds the link and revokes the token instead of leaving it live and unaudited", async () => {
    await start();
    const admin = await adminClient(t.gateway);
    open.push(admin);
    auditFails = true;
    await expect(
      admin.call("devices.setupToken.create", { scopes: ["operator.read"] }),
    ).rejects.toThrow(/unavailable/);
    auditFails = false;
    const list = await admin.call<{ setupTokens: { status: string }[] }>(
      "devices.setupToken.list",
      {},
    );
    expect(list.setupTokens.map((s) => s.status)).toEqual(["revoked"]);
  });

  it("logs a failed audit of a pairing, without the token or the error text", async () => {
    const db = openDb(":memory:");
    const lines: { level: string; msg: string; fields?: unknown }[] = [];
    const hook = setupTokenUsedHook({
      db,
      audit: {
        append: async () => {
          throw new Error("disk full pst_secretsecretsecretsecretsecretsecretsecret");
        },
      },
      log: { log: (level, msg, fields) => void lines.push({ level, msg, fields }) },
    });
    hook({ tokenId: "tok-1", deviceId: "dev-1", scopes: ["operator.read"] });
    await new Promise((r) => setTimeout(r, 10));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn", fields: { tokenId: "tok-1" } });
    expect(JSON.stringify(lines)).not.toContain("secretsecret");
  });
});
