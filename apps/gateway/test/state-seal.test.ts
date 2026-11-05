import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditLog, MemoryAuditStore } from "@psyche/audit";
import {
  DEFAULT_MIGRATIONS_DIR,
  getDevice,
  getSetting,
  insertDevice,
  openDb,
  type PsycheDb,
  setSetting,
} from "@psyche/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRESENCE_ENROLLED_SETTING } from "../src/presence-gate.ts";
import { SEALED_TABLES } from "../src/security/seal-spec.ts";
import { ensureSecurityState, SEAL_KEY_FILE, StateSeal } from "../src/security/state-seal.ts";

/**
 * The security-state seal (docs/design/security-state-integrity-2026.md §7.1): the Gateway's own
 * writes keep it valid, a write from another connection is undone and alerted, and a broken seal
 * makes the state untrusted.
 */

let home = "";
let dbPath = "";
const open: PsycheDb[] = [];

function db(): PsycheDb {
  const d = openDb(dbPath);
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

const ADMIN = ["operator.read", "operator.write", "operator.approvals", "operator.admin"] as const;

function pairDevice(d: PsycheDb, id: string, scopes: readonly string[] = ADMIN): void {
  insertDevice(d, {
    id,
    name: `device ${id}`,
    platform: "macos",
    role: "client",
    publicKey: Buffer.alloc(32, id.length),
    scopes: scopes as never,
    pairedAt: d.now(),
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "psyche-seal-"));
  dbPath = join(home, "state", "psyche.sqlite");
});

afterEach(() => {
  for (const d of open.splice(0)) d.close();
  rmSync(home, { recursive: true, force: true });
});

describe("state seal", () => {
  it("first start seals what is there, quietly on a fresh install", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    expect(seal.status()).toEqual({ status: "sealed", reason: null });
    expect(existsSync(join(home, SEAL_KEY_FILE))).toBe(true);
    expect(seal.alerts.open()).toEqual([]);
  });

  it("upgrades a database made before the seal existed (forward migration, then a first seal)", async () => {
    // The migrations of the previous release: everything but the seal's.
    const before = join(home, "migrations-before");
    mkdirSync(before);
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
      if (f.endsWith(".sql") && !f.includes("security-seal")) {
        copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(before, f));
      }
    }
    const old = openDb(dbPath, { migrationsDir: before });
    expect(
      old.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'security_seal'").get(),
    ).toBeUndefined();
    pairDevice(old, "phone");
    setSetting(old, PRESENCE_ENROLLED_SETTING, true);
    old.close();
    const d = db(); // this release: applies 202611051800_gateway_security-seal
    const seal = await StateSeal.open(d, { home });
    expect(seal.status().status).toBe("sealed");
    expect(seal.alerts.open().map((a) => a.kind)).toEqual(["state_first_seal"]);
    expect(getSetting(d, PRESENCE_ENROLLED_SETTING)?.value).toBe(true);
    // From now on an edit from outside is caught.
    foreign((f) => setSetting(f, PRESENCE_ENROLLED_SETTING, false));
    seal.ensure();
    expect(getSetting(d, PRESENCE_ENROLLED_SETTING)?.value).toBe(true);
  });

  it("an upgrade with paired devices gets one first-seal notice", async () => {
    const d = db();
    pairDevice(d, "dev-a");
    const seal = await StateSeal.open(d, { home });
    const alerts = seal.alerts.open();
    expect(alerts.map((a) => a.kind)).toEqual(["state_first_seal"]);
    expect(alerts[0]?.details).toMatchObject({ devices: 1, admins: 1 });
  });

  it("the Gateway's own writes keep the seal valid", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pairDevice(d, "dev-a");
    setSetting(d, PRESENCE_ENROLLED_SETTING, true);
    setSetting(d, "permissions.policy", { folders: [] });
    setSetting(d, "appearance.theme", "dark"); // not sealed
    d.sqlite.prepare("UPDATE devices SET last_seen_at = ? WHERE id = 'dev-a'").run(d.now());
    d.sqlite.prepare("DELETE FROM settings WHERE key = 'permissions.policy'").run();
    seal.ensure();
    d.close();
    open.length = 0;
    const again = await StateSeal.open(db(), { home });
    expect(again.status().status).toBe("sealed");
    expect(again.alerts.open()).toEqual([]);
  });

  it("own bulk deletes and foreign-key cascades keep the seal valid", async () => {
    const d = db();
    pairDevice(d, "dev-a");
    d.sqlite
      .prepare(
        `INSERT INTO passkeys (id, device_id, credential_id, public_key, name, created_at)
         VALUES ('pk1', 'dev-a', 'cred', x'01', 'key', ?)`,
      )
      .run(d.now());
    d.sqlite
      .prepare(
        `INSERT INTO grants (id, kind, scope, grant_key, subject, side_effect, created_at, updated_at)
         VALUES ('g1', 'site', 'always', 'k', '{}', 'read', ?, ?)`,
      )
      .run(d.now(), d.now());
    const seal = await StateSeal.open(d, { home });
    d.sqlite.prepare("DELETE FROM devices WHERE id = 'dev-a'").run(); // cascades to the passkey
    d.sqlite.prepare("DELETE FROM grants").run(); // no WHERE: no truncate shortcut with triggers
    expect(
      d.sqlite
        .prepare(
          "SELECT count(*) AS n FROM security_ledger WHERE tbl IN ('passkeys', 'grants', 'devices')",
        )
        .get(),
    ).toEqual({ n: 0 });
    foreign((f) => setSetting(f, "appearance.theme", "dark")); // any foreign commit: a full check
    seal.ensure();
    expect(seal.status().status).toBe("sealed");
    expect(seal.alerts.open().map((a) => a.kind)).toEqual(["state_first_seal"]);
  });

  it("undoes a device added by another program, at the next check", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    const revoked: string[][] = [];
    seal.onDevicesRevoked((ids) => revoked.push(ids));
    foreign((f) => pairDevice(f, "rogue"));
    // The row is there until the check; the check runs before every authorizing read.
    expect(getDevice(d, "rogue")?.revokedAt).toBeNull();
    seal.ensure();
    const rogue = getDevice(d, "rogue");
    expect(rogue?.revokedAt).not.toBeNull();
    expect(rogue?.scopes).toEqual([]);
    expect(revoked).toEqual([["rogue"]]);
    const [alert] = seal.alerts.open();
    expect(alert?.kind).toBe("state_changed_outside");
    expect(alert?.details.changes).toEqual([
      { table: "devices", change: "added", name: "device rogue" },
    ]);
    // Recorded in the revocation ledger, so a restore cannot bring it back.
    expect(readFileSync(join(home, "security", "revocations.jsonl"), "utf8")).toContain("rogue");
    // The neutralized row is sealed as revoked: the next check finds nothing.
    seal.ensure();
    expect(seal.alerts.open()).toHaveLength(1);
  });

  it("puts back a widened device, an un-revoked device, and a deleted one", async () => {
    const d = db();
    pairDevice(d, "phone", ["operator.read"]);
    pairDevice(d, "old");
    d.sqlite.prepare("UPDATE devices SET revoked_at = ? WHERE id = 'old'").run(d.now());
    pairDevice(d, "laptop");
    const seal = await StateSeal.open(d, { home });
    seal.alerts.acknowledge(seal.alerts.open()[0]?.id ?? "", null);
    foreign((f) => {
      f.sqlite
        .prepare(`UPDATE devices SET scopes = ? WHERE id = 'phone'`)
        .run(JSON.stringify(ADMIN));
      f.sqlite.prepare("UPDATE devices SET revoked_at = NULL WHERE id = 'old'").run();
      f.sqlite.prepare("DELETE FROM devices WHERE id = 'laptop'").run();
    });
    seal.ensure();
    expect(getDevice(d, "phone")?.scopes).toEqual(["operator.read"]);
    expect(getDevice(d, "old")?.revokedAt).not.toBeNull();
    expect(getDevice(d, "laptop")?.publicKey).toBe(Buffer.alloc(32, 6).toString("base64url"));
    const changes = seal.alerts.open()[0]?.details.changes ?? [];
    expect(changes.map((c) => `${c.change}:${c.name}`).sort()).toEqual([
      "modified:device old",
      "modified:device phone",
      "removed:device laptop",
    ]);
  });

  it("undoes presence keys, presence enrollment and policy edited by another program", async () => {
    const d = db();
    setSetting(d, PRESENCE_ENROLLED_SETTING, true);
    setSetting(d, "_presence.helperKeys", {
      mine: { publicKey: "A", keyId: "1", registeredAt: "x" },
    });
    setSetting(d, "permissions.policy", { deny: ["x"] });
    const seal = await StateSeal.open(d, { home });
    foreign((f) => {
      setSetting(f, "_presence.helperKeys", {
        mine: { publicKey: "A", keyId: "1", registeredAt: "x" },
        evil: { publicKey: "B", keyId: "2", registeredAt: "y" },
      });
      setSetting(f, PRESENCE_ENROLLED_SETTING, false);
      f.sqlite.prepare("DELETE FROM settings WHERE key = 'permissions.policy'").run();
      setSetting(f, "exec.host.enabled", true);
      setSetting(f, "appearance.theme", "light"); // not security state: left alone
    });
    seal.ensure();
    expect(getSetting(d, PRESENCE_ENROLLED_SETTING)?.value).toBe(true);
    expect(Object.keys(getSetting(d, "_presence.helperKeys")?.value as object)).toEqual(["mine"]);
    expect(getSetting(d, "permissions.policy")?.value).toEqual({ deny: ["x"] });
    expect(getSetting(d, "exec.host.enabled")).toBeUndefined();
    expect(getSetting(d, "appearance.theme")?.value).toBe("light");
    expect(seal.status().status).toBe("sealed");
  });

  it("revokes a grant and invalidates an approval added outside Psyche", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    foreign((f) => {
      f.sqlite
        .prepare(
          `INSERT INTO grants (id, kind, scope, grant_key, subject, side_effect, created_at, updated_at)
           VALUES ('g1', 'exec_host', 'always', 'k', '{}', 'destructive', ?, ?)`,
        )
        .run(f.now(), f.now());
    });
    seal.ensure();
    const g = d.sqlite
      .prepare("SELECT revoked_at, revoked_reason FROM grants WHERE id = 'g1'")
      .get() as {
      revoked_at: string | null;
      revoked_reason: string | null;
    };
    expect(g.revoked_at).not.toBeNull();
    expect(g.revoked_reason).toBe("state_tampered");
  });

  it("repairs at the next start what changed while the Gateway was stopped", async () => {
    const d = db();
    pairDevice(d, "phone", ["operator.read"]);
    await StateSeal.open(d, { home });
    d.close();
    open.length = 0;
    foreign((f) => f.sqlite.prepare(`UPDATE devices SET scopes = '["operator.admin"]'`).run());
    const d2 = db();
    const seal = await StateSeal.open(d2, { home });
    expect(getDevice(d2, "phone")?.scopes).toEqual(["operator.read"]);
    expect(seal.alerts.open().map((a) => a.kind)).toContain("state_changed_outside");
  });

  it("refuses inside an open transaction instead of reading a changed row", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    foreign((f) => pairDevice(f, "rogue"));
    expect(() => d.sqlite.transaction(() => seal.ensure())()).toThrow(/changed outside/);
    seal.ensure();
    expect(getDevice(d, "rogue")?.revokedAt).not.toBeNull();
  });

  it("a deleted seal with the key on disk is untrusted, and stays so", async () => {
    const d = db();
    pairDevice(d, "phone");
    await StateSeal.open(d, { home });
    d.close();
    open.length = 0;
    foreign((f) => f.sqlite.prepare("DELETE FROM security_seal").run());
    const seal = await StateSeal.open(db(), { home });
    expect(seal.status()).toEqual({ status: "untrusted", reason: "seal_missing" });
    open[0]?.close();
    open.length = 0;
    const again = await StateSeal.open(db(), { home });
    expect(again.status().status).toBe("untrusted");
    expect(again.alerts.open().filter((a) => a.kind === "state_untrusted")).toHaveLength(1);
  });

  it("a seal reset (key, seal and ledger gone) is caught by the audit log", async () => {
    const audit = createAuditLog({ store: new MemoryAuditStore() });
    const d = db();
    await StateSeal.open(d, { home, audit });
    await new Promise((r) => setTimeout(r, 10));
    d.close();
    open.length = 0;
    rmSync(join(home, SEAL_KEY_FILE));
    foreign((f) => {
      f.sqlite.prepare("DELETE FROM security_seal").run();
      f.sqlite.prepare("DELETE FROM security_ledger").run();
      pairDevice(f, "rogue");
    });
    const seal = await StateSeal.open(db(), { home, audit });
    expect(seal.status()).toEqual({ status: "untrusted", reason: "seal_reset" });
  });

  it("a replaced key and a forged ledger entry make the state untrusted", async () => {
    const d = db();
    await StateSeal.open(d, { home });
    d.close();
    open.length = 0;
    const keyFile = join(home, SEAL_KEY_FILE);
    const original = readFileSync(keyFile, "utf8");
    writeFileSync(
      keyFile,
      JSON.stringify({ v: 1, key: Buffer.alloc(32, 7).toString("base64"), createdAt: "x" }),
    );
    expect((await StateSeal.open(db(), { home })).status().reason).toBe("key_changed");
    expect(original).not.toBe(readFileSync(keyFile, "utf8"));
    for (const x of open.splice(0)) x.close();
    // A fresh home for the forged-entry half.
    rmSync(home, { recursive: true, force: true });
    home = mkdtempSync(join(tmpdir(), "psyche-seal-"));
    dbPath = join(home, "state", "psyche.sqlite");

    const d2 = db();
    await StateSeal.open(d2, { home });
    d2.close();
    open.length = 0;
    foreign((f) => {
      pairDevice(f, "rogue");
      // A ledger entry for it, with a made-up mac: the program has no key.
      f.sqlite
        .prepare(
          "INSERT INTO security_ledger (tbl, pk, row, mac) VALUES ('devices', 'rogue', '{}', ?)",
        )
        .run("ab".repeat(32));
    });
    const seal = await StateSeal.open(db(), { home });
    expect(seal.status()).toEqual({ status: "untrusted", reason: "ledger_mismatch" });
    // The forged entry does not protect the row: it is still revoked.
    expect(getDevice(open[0] as PsycheDb, "rogue")?.revokedAt).not.toBeNull();
  });

  it("a restored backup is sealed again as it is", async () => {
    const d = db();
    pairDevice(d, "phone");
    await StateSeal.open(d, { home });
    d.close();
    open.length = 0;
    rmSync(join(home, SEAL_KEY_FILE)); // a new machine
    const seal = await StateSeal.open(db(), { home, restored: true });
    expect(seal.status().status).toBe("sealed");
    const resealed = seal.alerts.open().filter((a) => a.kind === "state_resealed");
    expect(resealed.map((a) => a.details.restored)).toEqual([true]);
    expect(seal.alerts.open().some((a) => a.kind === "state_changed_outside")).toBe(false);
  });

  it("an alert deleted to hide it comes back", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    foreign((f) => pairDevice(f, "rogue"));
    seal.ensure();
    foreign((f) => f.sqlite.prepare("DELETE FROM security_alerts").run());
    seal.ensure();
    expect(seal.alerts.list().length).toBeGreaterThanOrEqual(2);
  });

  it("ensureSecurityState finds the seal of a connection", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    foreign((f) => pairDevice(f, "rogue"));
    ensureSecurityState(d);
    expect(seal.alerts.open()).toHaveLength(1);
  });

  it("every column of a sealed table is sealed or deliberately ignored", () => {
    const d = db();
    for (const spec of SEALED_TABLES) {
      const cols = (d.sqlite.pragma(`table_info(${spec.table})`) as { name: string }[]).map(
        (c) => c.name,
      );
      expect([...spec.columns, ...(spec.ignored ?? [])].sort(), spec.table).toEqual(cols.sort());
    }
  });
});
