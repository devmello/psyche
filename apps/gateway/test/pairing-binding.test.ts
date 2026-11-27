import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDevice, openDb } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import { keyFingerprint } from "../src/auth.ts";
import { forgetPairingBinding } from "../src/security/pairing-bindings.ts";
import {
  adminClient,
  TestClient as Client,
  handshake,
  newDeviceKey,
  startTestGateway,
  type TestClient,
  type TestGateway,
  verified,
  wsUrlOf,
} from "./helpers.ts";

/**
 * The card tap (`devices.approve`) pairs only the device and key the Gateway bound when it made
 * the request at the hello, never what the unsealed `pairing_requests` row says now.
 */

let t: TestGateway | undefined;
const open: TestClient[] = [];
let dbPath = "";

afterEach(async () => {
  for (const c of open.splice(0)) c.close();
  await t?.cleanup();
  t = undefined;
});

async function boot(): Promise<TestGateway> {
  const home = mkdtempSync(join(tmpdir(), "psyche-bind-"));
  dbPath = join(home, "state", "psyche.sqlite");
  t = await startTestGateway({ home, config: { dbPath } });
  return t;
}

async function hello(gw: TestGateway, deviceId: string, key = newDeviceKey()) {
  const c = await Client.open(wsUrlOf(gw.gateway));
  open.push(c);
  const res = await handshake(c, gw.gateway.origin, { key, deviceId });
  const v = verified<{ phase: string; pairingRequestId: string; code: string }>(res);
  return { key, ...v };
}

/** Another program on the Mac rewrites A's request to name B (its own device and key). */
function swap(requestId: string, b: { deviceId: string; publicKey: string }): void {
  const f = openDb(dbPath, { migrate: false });
  try {
    f.sqlite
      .prepare(
        "UPDATE pairing_requests SET device_id = ?, public_key_fingerprint = ?, expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
      )
      .run(b.deviceId, keyFingerprint(b.publicKey), requestId);
  } finally {
    f.close();
  }
}

const alerts = (gw: TestGateway) =>
  gw.gateway.context.db.sqlite.prepare("SELECT kind FROM security_alerts").pluck().all();

describe("devices.approve (the card tap)", () => {
  it("a request rewritten to another device is refused, nothing paired, alert raised", async () => {
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    const a = await hello(gw, "owner-a");
    const b = await hello(gw, "attacker-b");
    swap(a.pairingRequestId, { deviceId: "attacker-b", publicKey: b.key.publicKey });
    const res = await admin.request("devices.approve", {
      pairingRequestId: a.pairingRequestId,
      scopes: ["operator.read", "operator.admin"],
      code: a.code,
    });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
    const db = gw.gateway.context.db;
    expect(getDevice(db, "attacker-b")?.pairedAt).toBeNull();
    expect(getDevice(db, "owner-a")?.pairedAt).toBeNull();
    expect(alerts(gw)).toContain("state_changed_outside");
  });

  it("positive control: untouched, the tap pairs A with the scopes given", async () => {
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    const a = await hello(gw, "owner-a");
    await hello(gw, "attacker-b");
    const done = await admin.call<{ device: { id: string; scopes: string[] } }>("devices.approve", {
      pairingRequestId: a.pairingRequestId,
      scopes: ["operator.read"],
      code: a.code,
    });
    expect(done.device).toMatchObject({ id: "owner-a", scopes: ["operator.read"] });
    expect(getDevice(gw.gateway.context.db, "attacker-b")?.pairedAt).toBeNull();
    expect(alerts(gw)).not.toContain("state_changed_outside");
  });

  it("after a restart an old request is refused; the device's next hello gets a fresh code that pairs", async () => {
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    const first = await hello(gw, "owner-a");
    // What a restart leaves: the row, and no binding for it.
    forgetPairingBinding(gw.gateway.context.db, first.pairingRequestId);
    expect(
      await admin.request("devices.approve", {
        pairingRequestId: first.pairingRequestId,
        scopes: ["operator.read"],
        code: first.code,
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(alerts(gw)).not.toContain("state_changed_outside");

    const again = await hello(gw, "owner-a", first.key);
    expect(again.phase).toBe("pending");
    expect(again.pairingRequestId).not.toBe(first.pairingRequestId);
    const old = gw.gateway.context.db.sqlite
      .prepare("SELECT status FROM pairing_requests WHERE id = ?")
      .pluck()
      .get(first.pairingRequestId);
    expect(old).toBe("expired");
    const done = await admin.call<{ device: { id: string } }>("devices.approve", {
      pairingRequestId: again.pairingRequestId,
      scopes: ["operator.read"],
      code: again.code,
    });
    expect(done.device.id).toBe("owner-a");
  });

  it("a second hello while the bound request is live keeps the same code", async () => {
    const gw = await boot();
    const first = await hello(gw, "owner-a");
    const again = await hello(gw, "owner-a", first.key);
    expect(again.pairingRequestId).toBe(first.pairingRequestId);
    expect(again.code).toBe(first.code);
  });
});
