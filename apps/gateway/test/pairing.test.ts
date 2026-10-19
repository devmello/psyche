import { mkdtempSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDevice } from "@psyche/db";
import { type PairingRequest, PROTOCOL_VERSION } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { keyFingerprint } from "../src/auth.ts";
import { runCli } from "../src/cli.ts";
import {
  adminClient,
  desktopClient,
  handshake,
  ik,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  verified,
  wsUrlOf,
} from "./helpers.ts";

let t: TestGateway;
const open: TestClient[] = [];

async function client(headers: Record<string, string> = {}): Promise<TestClient> {
  const c = await TestClient.open(wsUrlOf(t.gateway), headers);
  open.push(c);
  return c;
}

function phaseOf(res: { verifyRes: Record<string, unknown> | null }): unknown {
  return verified<{ phase?: string } | undefined>(res)?.phase;
}

function closed(c: TestClient): Promise<void> {
  return new Promise((resolve) => {
    if (c.ws.readyState === c.ws.CLOSED) resolve();
    else c.ws.once("close", () => resolve());
  });
}

afterEach(async () => {
  for (const c of open.splice(0)) c.close();
  await t?.cleanup();
});

describe("loopback auto-pairing", () => {
  it("pairs the desktop with the handshake secret but never with operator.admin", async () => {
    t = await startTestGateway();
    const c = await client();
    const res = await handshake(c, t.gateway.origin, {
      handshakeSecret: t.gateway.handshakeSecret,
    });
    expect(res.verifyRes?.payload).toMatchObject({
      phase: "paired",
      scopes: ["operator.read", "operator.write", "operator.approvals"],
    });
    expect(await c.request("devices.list", {})).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(
      await c.request("settings.set", { key: "permissions.mode", value: "auto" }, ik()),
    ).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
  });

  it("does not auto-pair other device families, a browser Origin, or without the secret", async () => {
    t = await startTestGateway();
    const secret = t.gateway.handshakeSecret;
    expect(
      phaseOf(
        await handshake(await client(), t.gateway.origin, {
          handshakeSecret: secret,
          deviceFamily: "cli",
        }),
      ),
    ).toBe("pending");
    expect(
      phaseOf(
        await handshake(await client({ Origin: t.gateway.origin }), t.gateway.origin, {
          handshakeSecret: secret,
        }),
      ),
    ).toBe("pending");
    expect(phaseOf(await handshake(await client(), t.gateway.origin, {}))).toBe("pending");
    expect(
      phaseOf(await handshake(await client(), t.gateway.origin, { handshakeSecret: "wrong" })),
    ).toBe("pending");
  });

  it("ignores identity headers from a proxy", async () => {
    t = await startTestGateway();
    const c = await client({
      "Tailscale-User-Login": "owner@example.test",
      "Cf-Access-Authenticated-User-Email": "owner@example.test",
      "X-Forwarded-For": "127.0.0.1",
    });
    expect(phaseOf(await handshake(c, t.gateway.origin, {}))).toBe("pending");
  });

  it("refuses role: client on the node socket", async () => {
    t = await startTestGateway();
    const socket = createConnection(t.gateway.config.nodeSocketPath);
    await new Promise((r) => socket.once("connect", r));
    const reply = new Promise<Record<string, unknown>>((resolve) =>
      socket.once("data", (d) => resolve(JSON.parse(String(d).split("\n")[0] ?? "{}"))),
    );
    const key = newDeviceKey();
    socket.write(
      `${JSON.stringify({
        type: "req",
        id: "1",
        method: "connect",
        params: {
          protocolVersion: { min: 1, max: PROTOCOL_VERSION },
          deviceId: "sneaky",
          publicKey: key.publicKey,
          role: "client",
          platform: "macos",
          deviceFamily: "desktop",
          name: "desktop",
          handshakeSecret: readFileSync(join(t.home, "run", "handshake.secret"), "utf8").trim(),
        },
      })}\n`,
    );
    expect(await reply).toMatchObject({ ok: false, error: { code: "forbidden" } });
    socket.destroy();
  });
});

describe("remote approval", () => {
  it("creates a pending request with the key fingerprint, approved by an admin with owner-chosen scopes", async () => {
    t = await startTestGateway();
    const admin = await adminClient(t.gateway);
    open.push(admin);
    const key = newDeviceKey();
    const phone = await client();
    const pending = await handshake(phone, t.gateway.origin, {
      key,
      deviceId: "phone-1",
      deviceFamily: "ios-app",
    });
    const { pairingRequestId, code } = verified<{
      pairingRequestId: string;
      code: string;
    }>(pending);
    const evt = await admin.waitForEvent((e) => e.event === "pairing.requested");
    const request = (evt.payload as { pairingRequest: PairingRequest }).pairingRequest;
    expect(request).toMatchObject({
      id: pairingRequestId,
      publicKeyFingerprint: keyFingerprint(key.publicKey),
      transport: "ws",
      remoteAddress: "127.0.0.1",
    });
    expect(await phone.request("threads.list", {})).toMatchObject({
      ok: false,
      error: { code: "pairing_pending" },
    });
    const listed = await admin.call<{ pairingRequests: PairingRequest[] }>(
      "devices.pairing.list",
      {},
    );
    expect(listed.pairingRequests.map((r) => r.id)).toEqual([pairingRequestId]);

    expect(
      await admin.request("devices.approve", {
        pairingRequestId,
        scopes: ["operator.read"],
        code: "WRON-GCOD",
      }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const wasClosed = closed(phone);
    const approved = await admin.call<{ device: { scopes: string[] } }>("devices.approve", {
      pairingRequestId,
      scopes: ["operator.read"],
      code,
    });
    expect(approved.device.scopes).toEqual(["operator.read"]);
    await wasClosed; // the pending connection reconnects to pick up its scopes
    const again = await client();
    const res = await handshake(again, t.gateway.origin, {
      key,
      deviceId: "phone-1",
      deviceFamily: "ios-app",
    });
    expect(res.verifyRes?.payload).toMatchObject({ phase: "paired", scopes: ["operator.read"] });
    expect((await again.request("threads.create", {}, ik())).error).toMatchObject({
      code: "forbidden",
    });
  });

  it("refuses a second key for a pending device id and re-checks the key on approval", async () => {
    t = await startTestGateway();
    const first = await handshake(await client(), t.gateway.origin, { deviceId: "phone-1" });
    expect(phaseOf(first)).toBe("pending");
    const second = await handshake(await client(), t.gateway.origin, { deviceId: "phone-1" });
    expect(second.verifyRes?.payload).toMatchObject({
      phase: "denied",
      reason: "device id in use by another key",
    });

    // The device row's key changing behind the request's back fails the approval.
    const admin = await adminClient(t.gateway);
    open.push(admin);
    const { pairingRequestId } = verified<{
      pairingRequestId: string;
    }>(first);
    t.gateway.context.db.sqlite
      .prepare("UPDATE devices SET public_key = ? WHERE id = 'phone-1'")
      .run(Buffer.alloc(32, 1));
    expect(
      await admin.request("devices.approve", { pairingRequestId, scopes: ["operator.read"] }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("denies a request and closes the pending connection", async () => {
    t = await startTestGateway();
    const admin = await adminClient(t.gateway);
    open.push(admin);
    const phone = await client();
    const pending = await handshake(phone, t.gateway.origin, { deviceId: "phone-2" });
    const { pairingRequestId } = verified<{
      pairingRequestId: string;
    }>(pending);
    const wasClosed = closed(phone);
    const denied = await admin.call<{ pairingRequest: PairingRequest }>("devices.deny", {
      pairingRequestId,
    });
    expect(denied.pairingRequest.status).toBe("denied");
    await wasClosed;
  });

  it("bootstraps the first admin with `psyched devices approve <code>` on the machine", async () => {
    // The CLI opens the same SQLite file the Gateway uses.
    const home = mkdtempSync(join(tmpdir(), "psyche-gw-"));
    t = await startTestGateway({ home, config: { dbPath: join(home, "state", "psyche.sqlite") } });
    const key = newDeviceKey();
    const pending = await handshake(await client(), t.gateway.origin, { key, deviceId: "laptop" });
    const { code } = verified<{ code: string }>(pending);
    const lines: string[] = [];
    const prev = process.env.PSYCHE_HOME;
    process.env.PSYCHE_HOME = t.home;
    try {
      expect(runCli(["devices", "approve", code.toLowerCase()], (l) => lines.push(l))).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.PSYCHE_HOME;
      else process.env.PSYCHE_HOME = prev;
    }
    expect(lines.join("\n")).toMatch(/approved/);
    const res = await handshake(await client(), t.gateway.origin, { key, deviceId: "laptop" });
    expect(verified<{ scopes: string[] }>(res).scopes).toContain("operator.admin");
  });
});

describe("revocation and bad credentials", () => {
  it("revokes a device: its connections close and it can never re-pair", async () => {
    t = await startTestGateway();
    const admin = await adminClient(t.gateway);
    open.push(admin);
    const key = newDeviceKey();
    const desk = await desktopClient(t.gateway, key, "desk-1");
    open.push(desk);
    const wasClosed = closed(desk);
    const revoked = await admin.call<{ device: { revokedAt: string | null } }>("devices.revoke", {
      deviceId: "desk-1",
    });
    expect(revoked.device.revokedAt).not.toBeNull();
    await wasClosed;
    expect(getDevice(t.gateway.context.db, "desk-1")?.revokedAt).not.toBeNull();
    const again = await handshake(await client(), t.gateway.origin, {
      key,
      deviceId: "desk-1",
      handshakeSecret: t.gateway.handshakeSecret,
    });
    expect(again.verifyRes?.payload).toMatchObject({ phase: "denied", reason: "device revoked" });
  });

  it("rejects a bad signature, then rate-limits failed challenges per address", async () => {
    t = await startTestGateway({ limits: { failedChallengesPerMinute: 3 } });
    for (let i = 0; i < 3; i++) {
      const res = await handshake(await client(), t.gateway.origin, { tamperSignature: true });
      expect(res.verifyRes).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    }
    const blocked = await handshake(await client(), t.gateway.origin, { tamperSignature: true });
    expect(blocked.verifyRes).toMatchObject({ ok: false, error: { code: "rate_limited" } });
  });

  it("rejects a bad Origin with 403 before the upgrade", async () => {
    t = await startTestGateway();
    for (const origin of ["http://evil.test", "null", `http://localhost:${t.gateway.port}`]) {
      await expect(TestClient.open(wsUrlOf(t.gateway), { Origin: origin })).rejects.toThrow(/403/);
    }
  });

  it("limits new pairing requests per address per hour", async () => {
    t = await startTestGateway({ limits: { pairingsPerHour: 2 } });
    expect(phaseOf(await handshake(await client(), t.gateway.origin, {}))).toBe("pending");
    expect(phaseOf(await handshake(await client(), t.gateway.origin, {}))).toBe("pending");
    const third = await handshake(await client(), t.gateway.origin, {});
    expect(third.verifyRes).toMatchObject({ ok: false, error: { code: "rate_limited" } });
  });

  it("closes a pending connection when its request expires", async () => {
    t = await startTestGateway({ limits: { pairingTtlMs: 100 } });
    const c = await client();
    expect(phaseOf(await handshake(c, t.gateway.origin, {}))).toBe("pending");
    await closed(c);
  });
});
