import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlitePermissionStore } from "@psyche/permissions";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";

/**
 * Browser access was dropped (owner, 2026-11-25) and the `db_drop-web-devices` migration revoked
 * every `platform = 'web'` device, but not the standing grants those browsers approved. Grants are
 * sealed rows, so the Gateway ends them at startup through the broker's revoke path.
 */

let composed: ComposedGateway | null = null;
let home = "";

afterEach(async () => {
  await composed?.stop("test");
  composed?.gateway.context.db.close();
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

async function boot(): Promise<ComposedGateway> {
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  return composed;
}

async function stop(): Promise<void> {
  const c = composed;
  if (c === null) return;
  await c.stop("test");
  c.gateway.context.db.close();
  composed = null;
}

function insertDevice(c: ComposedGateway, id: string, platform: string, revoked: boolean): void {
  const now = new Date().toISOString();
  c.gateway.context.db.sqlite
    .prepare(
      `INSERT INTO devices (id, name, platform, role, public_key, token_hash, scopes, revoked_at,
         created_at, updated_at) VALUES (?, ?, ?, 'client', x'00', NULL, '[]', ?, ?, ?)`,
    )
    .run(id, id, platform, revoked ? now : null, now, now);
}

function insertGrant(c: ComposedGateway, id: string, deviceId: string | null): void {
  const now = new Date().toISOString();
  new SqlitePermissionStore(c.gateway.context.db.sqlite).insertGrant({
    grant: {
      id,
      kind: "new_origin",
      scope: "site",
      grantKey: `fetch|https://${id}.example`,
      subject: { origin: `https://${id}.example` },
      binding: null,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      useCount: 0,
      lastUsedAt: null,
      createdFromApprovalId: null,
      taskId: null,
      createdAt: now,
      revokedAt: null,
    },
    meta: {
      sideEffect: "read",
      sessionId: null,
      threadId: null,
      origin: `https://${id}.example`,
      createdByDeviceId: deviceId,
      maxUses: null,
      lastUsedBindingHash: null,
      revokedReason: null,
    },
  });
}

describe("grants created by a dropped browser device", () => {
  it("are revoked at startup and stop matching; phone, Mac and unattributed grants stay", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-webgrants-"));
    const first = await boot();
    // The browser device is already revoked (the migration did that); its grants are not.
    insertDevice(first, "browser-1", "web", true);
    insertDevice(first, "phone-1", "ios", false);
    insertDevice(first, "mac-1", "macos", false);
    insertGrant(first, "grt_web", "browser-1");
    insertGrant(first, "grt_phone", "phone-1");
    insertGrant(first, "grt_mac", "mac-1");
    insertGrant(first, "grt_none", null);
    expect((await first.broker.listGrants()).map((g) => g.id).sort()).toEqual([
      "grt_mac",
      "grt_none",
      "grt_phone",
      "grt_web",
    ]);
    await stop();

    const second = await boot();
    const active = (await second.broker.listGrants()).map((g) => g.id).sort();
    expect(active).toEqual(["grt_mac", "grt_none", "grt_phone"]);
    const all = await second.broker.listGrants({ includeRevoked: true });
    expect(all.find((g) => g.id === "grt_web")?.revokedAt).not.toBeNull();
    // The row is still valid after the seal-aware revoke: it reads back, with its reason.
    const rec = new SqlitePermissionStore(second.gateway.context.db.sqlite).getGrant("grt_web");
    expect(rec?.meta.revokedReason).toBe("device_revoked");
    await stop();

    // Idempotent: a third boot changes nothing.
    const third = await boot();
    expect((await third.broker.listGrants()).map((g) => g.id).sort()).toEqual(active);
  });
});
