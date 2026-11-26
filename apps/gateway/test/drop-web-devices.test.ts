import { readFileSync } from "node:fs";
import { getDevice, listDevices } from "@psyche/db";
import { PROTOCOL_VERSION } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adminClient,
  handshake,
  newDeviceKey,
  remoteClient,
  startTestGateway,
  TestClient,
  type TestGateway,
  wsUrlOf,
} from "./helpers.ts";

/**
 * Browser access was dropped (owner decision 2026-11-25): no device may pair as `web`, and a
 * browser paired before that is revoked, never listed, and still loads by id without a crash.
 */
const MIGRATION = new URL(
  "../../../packages/db/migrations/202611251100_db_drop-web-devices.sql",
  import.meta.url,
);

let t: TestGateway;

beforeEach(async () => {
  t = await startTestGateway();
});

afterEach(async () => {
  await t.cleanup();
});

async function connectAs(platform: string) {
  const c = await TestClient.open(wsUrlOf(t.gateway));
  const res = await c.request("connect", {
    protocolVersion: { min: 1, max: PROTOCOL_VERSION },
    deviceId: `dev-${platform}-${Math.random().toString(36).slice(2)}`,
    publicKey: newDeviceKey().publicKey,
    role: "client",
    platform,
    deviceFamily: platform === "ios" ? "ios-app" : "web",
    name: "test device",
  });
  c.close();
  return res;
}

describe("no web device platform", () => {
  it("refuses a connect that declares platform web", async () => {
    const res = await connectAs("web");
    expect(res).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  it("still takes a phone's connect (positive control)", async () => {
    const res = await connectAs("ios");
    expect(res).toMatchObject({ ok: true });
  });
});

describe("a browser paired before the drop", () => {
  it("is revoked by the migration, hidden from lists, loads by id and cannot reconnect", async () => {
    const db = t.gateway.context.db;
    const key = newDeviceKey();
    const browserId = "old-browser";
    (await remoteClient(t.gateway, key, browserId)).close();
    const phone = await remoteClient(t.gateway, newDeviceKey(), "phone-1");
    phone.close();
    // The row as an old Gateway left it: a paired browser, not revoked.
    db.sqlite.prepare("UPDATE devices SET platform = 'web' WHERE id = ?").run(browserId);
    db.sqlite.exec(readFileSync(MIGRATION, "utf8"));

    const row = db.sqlite
      .prepare("SELECT platform, revoked_at, token_hash FROM devices WHERE id = ?")
      .get(browserId) as { platform: string; revoked_at: string | null; token_hash: unknown };
    expect(row.platform).toBe("web");
    expect(row.revoked_at).not.toBeNull();
    expect(row.token_hash).toBeNull();

    // Never listed (the iPhone decodes DevicePlatform strictly), revoked or not; others still are.
    expect(listDevices(db).map((d) => d.id)).toContain("phone-1");
    expect(listDevices(db).map((d) => d.id)).not.toContain(browserId);
    expect(listDevices(db, { includeRevoked: true }).map((d) => d.id)).not.toContain(browserId);
    // A lookup by id (an audit row, a grant) does not crash.
    expect(getDevice(db, browserId)?.revokedAt).not.toBeNull();

    const admin = await adminClient(t.gateway);
    for (const includeRevoked of [false, true]) {
      const listed = await admin.request("devices.list", { includeRevoked });
      expect(listed).toMatchObject({ ok: true });
      const ids = (listed.payload as { devices: { id: string; platform: string }[] }).devices;
      expect(ids.map((d) => d.id)).toContain("phone-1");
      expect(ids.some((d) => d.id === browserId || d.platform === "web")).toBe(false);
    }
    admin.close();

    // Its key cannot come back, whatever platform it declares now.
    const again = await TestClient.open(wsUrlOf(t.gateway));
    const r = await handshake(again, t.gateway.origin, { key, deviceId: browserId });
    expect((r.verifyRes?.payload as { phase?: string } | undefined)?.phase).not.toBe("paired");
    again.close();
  });

  it("leaves an already revoked browser and every other device alone", async () => {
    const db = t.gateway.context.db;
    (await remoteClient(t.gateway, newDeviceKey(), "mac-2")).close();
    const before = db.sqlite
      .prepare("SELECT revoked_at, token_hash FROM devices WHERE id = 'mac-2'")
      .get() as { revoked_at: string | null; token_hash: unknown };
    db.sqlite.exec(readFileSync(MIGRATION, "utf8"));
    const after = db.sqlite
      .prepare("SELECT revoked_at, token_hash FROM devices WHERE id = 'mac-2'")
      .get() as { revoked_at: string | null; token_hash: unknown };
    expect(after).toEqual(before);
    expect(after.revoked_at).toBeNull();
  });
});
