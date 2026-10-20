import { copyFileSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDevice } from "@psyche/db";
import { SqlitePermissionStore, writeRestoreMarker } from "@psyche/permissions";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, desktopClient, newDeviceKey, type TestClient } from "./helpers.ts";

/**
 * S23 design-26: restoring a backup must not bring back revoked devices or grants. Revocations
 * go to `security/revocations.jsonl` (outside the backup); every boot replays it, and a restore
 * into a home without it un-pairs every device and revokes every standing grant.
 */

const clients: TestClient[] = [];
let composed: ComposedGateway | null = null;
let home = "";

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

const dbPath = () => join(home, "psyche.db");

async function boot(): Promise<ComposedGateway> {
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: dbPath(), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  return composed;
}

function insertGrant(c: ComposedGateway, id: string): void {
  const now = new Date().toISOString();
  new SqlitePermissionStore(c.gateway.context.db.sqlite).insertGrant({
    grant: {
      id,
      kind: "new_origin",
      scope: "site",
      grantKey: "fetch|https://energy-agency.example",
      subject: { origin: "https://energy-agency.example" },
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
      origin: "https://energy-agency.example",
      createdByDeviceId: null,
      maxUses: null,
      lastUsedBindingHash: null,
      revokedReason: null,
    },
  });
}

/** Pair D, add grant G, snapshot the database (the "backup"), then revoke both. */
async function backupThenRevoke() {
  home = mkdtempSync(join(tmpdir(), "psyche-restore-"));
  const c = await boot();
  const key = newDeviceKey();
  const d = await desktopClient(c.gateway, key, "desk-lost");
  d.close();
  insertGrant(c, "grt_restore");
  const snapshot = join(home, "snapshot.db");
  await c.gateway.context.db.sqlite.backup(snapshot);
  const admin = await adminClient(c.gateway);
  clients.push(admin);
  await admin.call("devices.revoke", { deviceId: "desk-lost" });
  await c.broker.revokeGrant("grt_restore");
  await c.stop("test");
  // The composition hands its connection to the server, so stop() leaves it open; a restore runs
  // with the Gateway process gone, so close it here before swapping the file.
  c.gateway.context.db.close();
  composed = null;
  // Restore the old database, as `psyche backup restore` does with the Gateway stopped.
  for (const suffix of ["-wal", "-shm"]) rmSync(`${dbPath()}${suffix}`, { force: true });
  copyFileSync(snapshot, dbPath());
  writeRestoreMarker(home, { restoredAt: new Date().toISOString(), backupCreatedAt: "earlier" });
  return { key };
}

describe("restore does not resurrect revocations (design-26)", () => {
  it("1: a device revoked after the backup cannot connect after the restore", async () => {
    const { key } = await backupThenRevoke();
    const c = await boot();
    expect(getDevice(c.gateway.context.db, "desk-lost")?.revokedAt).not.toBeNull();
    await expect(desktopClient(c.gateway, key, "desk-lost")).rejects.toThrow(/did not pair/);
    expect(existsSync(join(home, "security", "restored.json"))).toBe(false);
  });

  it("2: a grant revoked after the backup stays revoked and no longer matches", async () => {
    await backupThenRevoke();
    const c = await boot();
    const grants = await c.broker.listGrants({ includeRevoked: true });
    expect(grants.find((g) => g.id === "grt_restore")?.revokedAt).not.toBeNull();
    expect(await c.broker.listGrants()).toEqual([]);
  });

  it("a restore into a home without the ledger un-pairs devices and revokes every grant", async () => {
    await backupThenRevoke();
    rmSync(join(home, "security", "revocations.jsonl"), { force: true });
    const c = await boot();
    // Fail closed: the revoked device is back in the old database but no longer paired.
    const dev = getDevice(c.gateway.context.db, "desk-lost");
    expect(dev?.pairedAt ?? null).toBeNull();
    expect(dev?.scopes ?? []).toEqual([]);
    const g = (await c.broker.listGrants({ includeRevoked: true })).find(
      (x) => x.id === "grt_restore",
    );
    expect(g?.revokedAt).not.toBeNull();
    // The owner's desktop pairs again; a fresh ledger starts.
    const again = await desktopClient(c.gateway, newDeviceKey(), "desk-new");
    clients.push(again);
    expect(existsSync(join(home, "security", "revocations.jsonl"))).toBe(true);
  });
});

describe("restore does not resurrect deleted vault items (design-26)", () => {
  const TEST_ARGON2 = { memory: 64, passes: 1, parallelism: 1 };

  async function bootWithVault(keyFile: string): Promise<ComposedGateway> {
    composed = await composeGateway({
      env: { PSYCHE_VAULT_KEY_FILE: keyFile },
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: dbPath(), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      vault: { keyFile, argon2: TEST_ARGON2 },
    });
    return composed;
  }

  it("3: an item deleted after the backup is gone from the list and the store after the restore", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-restore-vault-"));
    const keyFile = join(home, "vault.key");
    writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
    const c = await bootWithVault(keyFile);
    await c.vault.setup();
    const kept = await c.vault.add({
      kind: "api_key",
      name: "Kept",
      bindings: [{ host: "api.kept.test" }],
      secret: { token: "kept-token-1234567890", headerName: "X-Api-Key" },
    });
    const gone = await c.vault.add({
      kind: "api_key",
      name: "Leaked",
      bindings: [{ host: "api.leaked.test" }],
      secret: { token: "leaked-token-1234567890", headerName: "X-Api-Key" },
    });
    // The "backup": the database and the vault directory as they were.
    const snapshot = join(home, "snapshot.db");
    await c.gateway.context.db.sqlite.backup(snapshot);
    c.vault.lock("manual");
    cpSync(join(home, "vault"), join(home, "vault-backup"), { recursive: true });
    await c.vault.unlock("test");
    expect(await c.vault.delete(gone.id)).toBe(true);
    await c.stop("test");
    c.gateway.context.db.close();
    composed = null;

    for (const suffix of ["-wal", "-shm"]) rmSync(`${dbPath()}${suffix}`, { force: true });
    copyFileSync(snapshot, dbPath());
    rmSync(join(home, "vault"), { recursive: true, force: true });
    cpSync(join(home, "vault-backup"), join(home, "vault"), { recursive: true });
    writeRestoreMarker(home, { restoredAt: new Date().toISOString(), backupCreatedAt: "earlier" });

    const after = await bootWithVault(keyFile);
    // The mirror is clean before the vault is even unlocked.
    expect((await after.vault.list()).map((m) => m.id)).toEqual([kept.id]);
    await after.vault.unlock("test");
    expect((await after.vault.list()).map((m) => m.id)).toEqual([kept.id]);
    const dropped = await after.audit.query({ kind: "vault.restored_items_dropped" });
    expect(dropped.map((e) => e.data)).toEqual([{ count: 1 }]);
    // The row left the encrypted store itself: the next unlock has nothing to drop.
    after.vault.lock("manual");
    await after.vault.unlock("test");
    expect(await after.audit.query({ kind: "vault.restored_items_dropped" })).toHaveLength(1);
  });
});
