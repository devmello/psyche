import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MIGRATIONS_DIR, insertDevice, openDb, type PsycheDb } from "@psyche/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SEALED_ROW_MIGRATIONS, SEALED_TABLES } from "../src/security/seal-spec.ts";
import { StateSeal } from "../src/security/state-seal.ts";

/**
 * An update applies new migrations in `openDb`, before the seal opens. A migration that changes a
 * sealed row must not look like a change made outside Psyche: the seal would put the old row back
 * (un-revoking a device) and raise "changed outside".
 */

const DROP_WEB = "202611251100_db_drop-web-devices";
/** The seal's own migration: every later one runs on sealed installs. */
const SEAL_MIGRATION = "202611051800_gateway_security-seal";

let home = "";
let dbPath = "";
const open: PsycheDb[] = [];

function track(d: PsycheDb): PsycheDb {
  open.push(d);
  return d;
}

/** Another program on the Mac: its own connection, no triggers, no key. */
function foreign<T>(fn: (d: PsycheDb) => T): T {
  const d = openDb(dbPath, { migrate: false });
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

/** The migrations of an older install: every file that sorts before `id`. */
function migrationsBefore(id: string): string {
  const dir = join(home, `migrations-before-${id}`);
  mkdirSync(dir);
  for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
    if (f.endsWith(".sql") && f.slice(0, -".sql".length) < id) {
      copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
    }
  }
  return dir;
}

const ADMIN = ["operator.read", "operator.write", "operator.approvals", "operator.admin"] as const;

function pair(d: PsycheDb, id: string, platform: string): void {
  insertDevice(d, {
    id,
    name: `device ${id}`,
    platform: platform as never,
    role: "client",
    publicKey: Buffer.alloc(32, id.length),
    tokenHash: Buffer.alloc(32, 7 + id.length),
    scopes: ADMIN as never,
    pairedAt: d.now(),
  });
}

type DeviceRow = { revoked_at: string | null; token_hash: Buffer | null; scopes: string };

function deviceRow(d: PsycheDb, id: string): DeviceRow {
  return d.sqlite
    .prepare("SELECT revoked_at, token_hash, scopes FROM devices WHERE id = ?")
    .get(id) as DeviceRow;
}

/** An older install: sealed, with a browser and a Mac paired through the Gateway's own writes. */
async function olderInstall(): Promise<void> {
  const old = openDb(dbPath, { migrationsDir: migrationsBefore(DROP_WEB) });
  const seal = await StateSeal.open(old, { home });
  pair(old, "old-browser", "web");
  pair(old, "mac-2", "macos");
  seal.ensure();
  expect(seal.status().status).toBe("sealed");
  expect(deviceRow(old, "old-browser").token_hash).not.toBeNull();
  seal.close();
  old.close();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "psyche-seal-mig-"));
  dbPath = join(home, "state", "psyche.sqlite");
  mkdirSync(join(home, "state"));
});

afterEach(() => {
  for (const d of open.splice(0)) d.close();
  rmSync(home, { recursive: true, force: true });
});

describe("migrations that change sealed rows", () => {
  it("an update that drops a paired browser keeps it revoked, with no alert", async () => {
    await olderInstall();

    // The update: this build's migrations, then the seal, then its first checks.
    const d = track(openDb(dbPath));
    const applied = d.sqlite.prepare("SELECT id FROM _migrations WHERE id = ?").get(DROP_WEB);
    expect(applied).toBeDefined();
    const seal = await StateSeal.open(d, { home });
    seal.ensure();

    const browser = deviceRow(d, "old-browser");
    expect(browser.revoked_at).not.toBeNull();
    expect(browser.token_hash).toBeNull();
    expect(seal.status()).toEqual({ status: "sealed", reason: null });
    expect(seal.alerts.open().map((a) => a.kind)).toEqual([]);
    // Every other device as it was.
    expect(deviceRow(d, "mac-2").revoked_at).toBeNull();
    expect(deviceRow(d, "mac-2").token_hash).not.toBeNull();

    // And again on the next start: the migration's change is now sealed state.
    seal.close();
    d.close();
    open.length = 0;
    const d2 = track(openDb(dbPath));
    const seal2 = await StateSeal.open(d2, { home });
    seal2.ensure();
    expect(deviceRow(d2, "old-browser").token_hash).toBeNull();
    expect(deviceRow(d2, "old-browser").revoked_at).not.toBeNull();
    expect(seal2.status()).toEqual({ status: "sealed", reason: null });
    expect(seal2.alerts.open()).toEqual([]);
    seal2.close();
  });

  it("a foreign un-revoke after the update is still caught and undone", async () => {
    await olderInstall();
    const d = track(openDb(dbPath));
    const seal = await StateSeal.open(d, { home });
    seal.ensure();
    foreign((f) =>
      f.sqlite
        .prepare("UPDATE devices SET revoked_at = NULL, token_hash = ? WHERE id = 'old-browser'")
        .run(Buffer.alloc(32, 1)),
    );
    seal.ensure();
    expect(deviceRow(d, "old-browser").revoked_at).not.toBeNull();
    expect(deviceRow(d, "old-browser").token_hash).toBeNull();
    expect(seal.alerts.open().map((a) => a.kind)).toContain("state_changed_outside");
    seal.close();
  });

  it("revokes a browser the seal had already put back (an install updated before this fix)", async () => {
    // This build's migrations already applied, and the ledger holds the browser unrevoked: what an
    // earlier boot left when its seal undid the migration.
    const before = track(openDb(dbPath));
    const s0 = await StateSeal.open(before, { home });
    pair(before, "old-browser", "web");
    s0.ensure();
    s0.close();
    before.close();
    open.length = 0;

    const d = track(openDb(dbPath));
    const seal = await StateSeal.open(d, { home });
    seal.ensure();
    expect(deviceRow(d, "old-browser").revoked_at).not.toBeNull();
    expect(deviceRow(d, "old-browser").token_hash).toBeNull();
    expect(seal.status()).toEqual({ status: "sealed", reason: null });
    expect(seal.alerts.open()).toEqual([]);
    // Recorded like any revocation, so a restored backup cannot bring it back either.
    const ledger = join(home, "security", "revocations.jsonl");
    expect(existsSync(ledger) && readFileSync(ledger, "utf8")).toContain("old-browser");
    seal.close();
  });

  it("a foreign change on top of the migration is still alerted, and the browser stays revoked", async () => {
    await olderInstall();
    // Between the update's migrations and the seal: another program widens the browser's scopes.
    const d = track(openDb(dbPath));
    d.sqlite
      .prepare(`UPDATE devices SET scopes = '["operator.admin","node"]' WHERE id = 'old-browser'`)
      .run();
    const seal = await StateSeal.open(d, { home });
    seal.ensure();
    const browser = deviceRow(d, "old-browser");
    expect(browser.revoked_at).not.toBeNull();
    expect(browser.token_hash).toBeNull();
    expect(JSON.parse(browser.scopes)).toEqual([...ADMIN]);
    expect(seal.alerts.open().map((a) => a.kind)).toEqual(["state_changed_outside"]);
  });

  it("a browser deleted outside Psyche comes back revoked, with the alert", async () => {
    await olderInstall();
    const d = track(openDb(dbPath));
    d.sqlite.prepare("DELETE FROM devices WHERE id = 'old-browser'").run();
    const seal = await StateSeal.open(d, { home });
    seal.ensure();
    const browser = deviceRow(d, "old-browser");
    expect(browser.revoked_at).not.toBeNull();
    expect(browser.token_hash).toBeNull();
    expect(seal.alerts.open().map((a) => a.kind)).toEqual(["state_changed_outside"]);
  });

  it("other changes made outside at the update are still undone and alerted (positive control)", async () => {
    await olderInstall();
    const d = track(openDb(dbPath));
    // Shaped like the migration, but on a Mac: no migration does that.
    d.sqlite
      .prepare(
        "UPDATE devices SET revoked_at = '2026-11-27T00:00:00.000Z', token_hash = NULL, updated_at = '2026-11-27T00:00:00.000Z' WHERE id = 'mac-2'",
      )
      .run();
    const seal = await StateSeal.open(d, { home });
    seal.ensure();
    expect(deviceRow(d, "mac-2").revoked_at).toBeNull();
    expect(deviceRow(d, "mac-2").token_hash).not.toBeNull();
    expect(deviceRow(d, "old-browser").token_hash).toBeNull();
    const alerts = seal.alerts.open();
    expect(alerts.map((a) => a.kind)).toEqual(["state_changed_outside"]);
    expect(JSON.stringify(alerts[0]?.details)).toContain("mac-2");
    expect(JSON.stringify(alerts[0]?.details)).not.toContain("old-browser");
  });

  it("every migration since the seal that writes a sealed table is listed", () => {
    const sealed = new Set(SEALED_TABLES.map((t) => t.table));
    const listed = SEALED_ROW_MIGRATIONS.map((m) => m.id);
    const write =
      /\b(?:UPDATE(?:\s+OR\s+\w+)?|INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|DELETE\s+FROM|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE|RENAME\s+TO)\s+"?(\w+)"?/gi;
    const writers = new Set<string>();
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR).sort()) {
      const id = f.slice(0, -".sql".length);
      if (!f.endsWith(".sql") || id <= SEAL_MIGRATION) continue;
      const sql = readFileSync(join(DEFAULT_MIGRATIONS_DIR, f), "utf8").replace(/--[^\n]*/g, "");
      for (const m of sql.matchAll(write)) {
        if (sealed.has((m[1] as string).toLowerCase())) writers.add(id);
      }
    }
    // A new one needs an entry in SEALED_ROW_MIGRATIONS (or a seal test showing it leaves every
    // sealed row as it was) and its id here.
    expect([...writers]).toEqual([DROP_WEB]);
    for (const id of listed) expect(writers.has(id)).toBe(true);
  });
});
