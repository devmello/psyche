import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDevice,
  getSetting,
  insertDevice,
  openDb,
  type PsycheDb,
  setSetting,
  updateDevice,
} from "@psyche/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SEAL_KEY_FILE, StateSeal } from "../src/security/state-seal.ts";

/**
 * The adversarial review of the seal (PR #1270, H1–H6, M1–M3): every key-less path it found,
 * as a regression test. "Another program" is a second SQLite connection to the same file, with
 * no TEMP triggers and no key.
 */

let home = "";
let dbPath = "";
const open: PsycheDb[] = [];

function db(): PsycheDb {
  const d = openDb(dbPath);
  open.push(d);
  return d;
}

function foreign<T>(fn: (d: PsycheDb) => T): T {
  const d = openDb(dbPath, { migrate: false });
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

async function restart(): Promise<{ d: PsycheDb; seal: StateSeal }> {
  for (const x of open.splice(0)) x.close();
  const d = db();
  return { d, seal: await StateSeal.open(d, { home }) };
}

const ADMIN = ["operator.read", "operator.write", "operator.approvals", "operator.admin"];
const raw = (d: PsycheDb, sql: string, ...p: unknown[]) =>
  d.sqlite
    .prepare(sql)
    .pluck()
    .get(...p);

function pair(
  d: PsycheDb,
  id: string,
  scopes: string[] = ADMIN,
  pairedAt: string | null = d.now(),
) {
  insertDevice(d, {
    id,
    name: `device ${id}`,
    platform: "macos",
    role: "client",
    publicKey: Buffer.alloc(32, id.length),
    scopes: scopes as never,
    pairedAt,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "psyche-attack-"));
  dbPath = join(home, "state", "psyche.sqlite");
});

afterEach(() => {
  for (const d of open.splice(0)) d.close();
  rmSync(home, { recursive: true, force: true });
});

describe("H1: a trigger planted in the main schema", () => {
  it("is dropped before it can run on the Gateway's connection, and the state is untrusted", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "owner-mac");
    pair(d, "intruder", [], null);
    setSetting(d, "_presence.enrolled", true);
    seal.ensure();
    foreign((f) =>
      f.sqlite.exec(`CREATE TRIGGER t_evil AFTER UPDATE ON settings WHEN NEW.key = '_gateway.stateVersion'
        BEGIN UPDATE devices SET scopes = '["operator.read","operator.write","operator.approvals","operator.admin"]',
          paired_at = COALESCE(paired_at, NEW.updated_at) WHERE id = 'intruder';
        INSERT INTO settings (key, value, created_at, updated_at) VALUES ('_presence.enrolled', 'false', NEW.updated_at, NEW.updated_at)
          ON CONFLICT(key) DO UPDATE SET value = 'false'; END`),
    );
    seal.ensure();
    expect(
      raw(d, "SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name = 't_evil'"),
    ).toBe(0);
    expect(seal.status()).toEqual({ status: "untrusted", reason: "schema_tampered" });
    // The Gateway's routine writes now run nothing planted.
    setSetting(d, "_gateway.stateVersion", 1);
    setSetting(d, "_gateway.stateVersion", 2);
    expect(getDevice(d, "intruder")?.scopes).toEqual([]);
    expect(getSetting(d, "_presence.enrolled")?.value).toBe(true);
    const { d: d2, seal: again } = await restart();
    expect(again.status().status).toBe("untrusted");
    expect(getDevice(d2, "intruder")?.scopes).toEqual([]);
  });

  it("a planted trigger cannot call the seal's functions (direct-only, trusted_schema off)", async () => {
    const d = db();
    await StateSeal.open(d, { home });
    pair(d, "owner-mac");
    // Planted, then run on the Gateway's connection before any check could drop it.
    d.sqlite.exec(
      "CREATE TRIGGER t_mac AFTER UPDATE ON devices BEGIN SELECT psyche_seal_mac('a', 'b', 'c'); END",
    );
    expect(() =>
      d.sqlite.prepare("UPDATE devices SET name = 'x' WHERE id = 'owner-mac'").run(),
    ).toThrow(/unsafe use of psyche_seal_mac/);
  });

  it("an altered sealed table (another default) is untrusted", async () => {
    await StateSeal.open(db(), { home });
    for (const x of open.splice(0)) x.close();
    foreign((f) => f.sqlite.exec("ALTER TABLE devices ADD COLUMN backdoor TEXT DEFAULT 'x'"));
    const { seal } = await restart();
    expect(seal.status()).toEqual({ status: "untrusted", reason: "schema_tampered" });
  });

  it("an alert deleted as it is written is still told to the listeners", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    const told: string[] = [];
    seal.alerts.onAlert((a) => told.push(a.kind));
    d.sqlite.exec(
      "CREATE TRIGGER t_hide AFTER INSERT ON security_alerts BEGIN DELETE FROM security_alerts WHERE id = NEW.id; END",
    );
    seal.alerts.add("recovery_requested", { op: "presence.reset" });
    expect(told).toEqual(["recovery_requested"]);
  });
});

describe("H2: an emptied ledger with a zero aggregate", () => {
  it("does not verify, and destroys nothing", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "owner-mac");
    pair(d, "owner-phone");
    setSetting(d, "_presence.enrolled", true);
    setSetting(d, "exec.host", "off");
    seal.ensure();
    foreign((f) => {
      f.sqlite.prepare("DELETE FROM security_ledger").run();
      f.sqlite.prepare("UPDATE security_seal SET agg = ? WHERE id = 1").run("0".repeat(64));
    });
    seal.ensure();
    expect(seal.status().status).toBe("untrusted");
    expect(getDevice(d, "owner-mac")?.revokedAt).toBeNull();
    expect(seal.authorizeDevice(getDevice(d, "owner-mac") as never)).toEqual({
      ok: true,
      scopes: ADMIN,
    });
    expect(getSetting(d, "_presence.enrolled")?.value).toBe(true);
    expect(getSetting(d, "exec.host")?.value).toBe("off");
    const { d: d2, seal: again } = await restart();
    expect(again.status().status).toBe("untrusted");
    expect(getDevice(d2, "owner-mac")?.revokedAt).toBeNull();
  });

  it("a copied seal row with a forged state does not verify either", async () => {
    await StateSeal.open(db(), { home });
    for (const x of open.splice(0)) x.close();
    foreign((f) =>
      f.sqlite.prepare("UPDATE security_seal SET state = 'sealed', gen = gen + 5").run(),
    );
    const { seal } = await restart();
    expect(seal.status()).toEqual({ status: "untrusted", reason: "seal_forged" });
  });
});

describe("H3: one deleted ledger entry", () => {
  it("does not get the real row revoked", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "owner-mac");
    seal.ensure();
    foreign((f) =>
      f.sqlite.prepare("DELETE FROM security_ledger WHERE tbl='devices' AND pk='owner-mac'").run(),
    );
    seal.ensure();
    expect(getDevice(d, "owner-mac")?.revokedAt).toBeNull();
    expect(seal.status()).toEqual({ status: "untrusted", reason: "ledger_mismatch" });
    // The owner's own device keeps working (the shadow from this run knows it).
    expect(seal.authorizeDevice(getDevice(d, "owner-mac") as never)).toEqual({
      ok: true,
      scopes: ADMIN,
    });
  });
});

describe("H4: once untrusted", () => {
  it("after the key file is replaced, an inserted admin device gets read-only at most", async () => {
    const d = db();
    await StateSeal.open(d, { home });
    pair(d, "owner-mac");
    for (const x of open.splice(0)) x.close();
    rmSync(join(home, SEAL_KEY_FILE));
    const { d: d2, seal } = await restart();
    expect(seal.status()).toEqual({ status: "untrusted", reason: "key_changed" });
    foreign((f) => pair(f, "intruder"));
    seal.ensure();
    const intruder = getDevice(d2, "intruder");
    expect(seal.authorizeDevice(intruder as never)).toEqual({
      ok: true,
      scopes: ["operator.read"],
    });
    // A Gateway write to a row from before (pinning a family at connect) trusts nothing.
    updateDevice(d2, "owner-mac", { deviceFamily: "desktop" });
    seal.ensure();
    expect(seal.authorizeDevice(getDevice(d2, "owner-mac") as never)).toEqual({
      ok: true,
      scopes: ["operator.read"],
    });
  });

  it("mid-run: a device added or widened since the last trusted check is refused or narrowed", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "phone", ["operator.read"]);
    seal.ensure();
    foreign((f) => f.sqlite.prepare("DELETE FROM security_ledger WHERE pk = 'phone'").run());
    seal.ensure();
    expect(seal.status().status).toBe("untrusted");
    foreign((f) => {
      pair(f, "intruder");
      f.sqlite
        .prepare(`UPDATE devices SET scopes = ? WHERE id = 'phone'`)
        .run(JSON.stringify(ADMIN));
    });
    seal.ensure();
    // Unknown to the Gateway: read-only at most (nothing a same-user program cannot read anyway).
    expect(seal.authorizeDevice(getDevice(d, "intruder") as never)).toEqual({
      ok: true,
      scopes: ["operator.read"],
    });
    // The widened scopes were put back from memory; even read raw, the shadow narrows them.
    expect(getDevice(d, "phone")?.scopes).toEqual(["operator.read"]);
    expect(
      seal.authorizeDevice({
        id: "phone",
        publicKey: getDevice(d, "phone")?.publicKey ?? "",
        scopes: ADMIN as never,
      }),
    ).toEqual({
      ok: true,
      scopes: ["operator.read"],
    });
    // Untrusted settings read the value the Gateway knows, not what the file says.
    setSetting(d, "permissions.policy", { deny: ["x"] });
    seal.ensure();
    foreign((f) => setSetting(f, "permissions.policy", { deny: [] }));
    expect(getSetting(d, "permissions.policy")?.value).toEqual({ deny: ["x"] });
  });
});

describe("H5: replays and rollbacks", () => {
  it("an old genuine ledger entry does not bring a revoked device back", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "old-phone");
    seal.ensure();
    const snap = foreign((f) => ({
      dev: f.sqlite.prepare("SELECT * FROM devices WHERE id='old-phone'").get() as Record<
        string,
        unknown
      >,
      led: f.sqlite
        .prepare("SELECT * FROM security_ledger WHERE tbl='devices' AND pk='old-phone'")
        .get() as Record<string, unknown>,
    }));
    d.sqlite
      .prepare("UPDATE devices SET revoked_at = ?, scopes='[]' WHERE id='old-phone'")
      .run(d.now());
    seal.ensure();
    foreign((f) => {
      f.sqlite
        .prepare(
          "UPDATE devices SET revoked_at = NULL, scopes = ?, token_hash = ?, updated_at = ? WHERE id='old-phone'",
        )
        .run(snap.dev.scopes, snap.dev.token_hash, snap.dev.updated_at);
      f.sqlite
        .prepare(
          "UPDATE security_ledger SET row = ?, mac = ? WHERE tbl='devices' AND pk='old-phone'",
        )
        .run(snap.led.row, snap.led.mac);
    });
    seal.ensure();
    expect(getDevice(d, "old-phone")?.revokedAt).not.toBeNull();
    expect(seal.status().status).toBe("untrusted");
    expect(seal.authorizeDevice(getDevice(d, "old-phone") as never)).toEqual({ ok: false });
  });

  it("rolling back the sealed tables, ledger and seal row together is caught", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "old-phone");
    seal.ensure();
    const tables = [
      "devices",
      "settings",
      "security_ledger",
      "security_seal",
      "security_alerts",
      "security_recoveries",
      "grants",
    ];
    const snap = foreign((f) =>
      Object.fromEntries(tables.map((t) => [t, f.sqlite.prepare(`SELECT * FROM ${t}`).all()])),
    );
    d.sqlite
      .prepare("UPDATE devices SET revoked_at = ?, scopes='[]' WHERE id='old-phone'")
      .run(d.now());
    seal.ensure();
    foreign((f) => {
      f.sqlite.pragma("foreign_keys = OFF");
      f.sqlite.transaction(() => {
        for (const t of tables) {
          f.sqlite.prepare(`DELETE FROM ${t}`).run();
          for (const r of snap[t] as Record<string, unknown>[]) {
            const cols = Object.keys(r);
            f.sqlite
              .prepare(
                `INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
              )
              .run(...cols.map((c) => r[c]));
          }
        }
      })();
    });
    seal.ensure();
    expect(seal.status()).toEqual({ status: "untrusted", reason: "rollback" });
    expect(getDevice(d, "old-phone")?.revokedAt).not.toBeNull();
  });

  it("a database behind the generation recorded at the last clean stop is a rollback", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    const copy = join(home, "copy.sqlite");
    d.sqlite.prepare("VACUUM INTO ?").run(copy);
    pair(d, "phone");
    d.sqlite.prepare("UPDATE devices SET revoked_at = ? WHERE id = 'phone'").run(d.now());
    seal.close();
    for (const x of open.splice(0)) x.close();
    for (const f of readdirSync(join(home, "state"))) rmSync(join(home, "state", f));
    const { renameSync } = await import("node:fs");
    renameSync(copy, dbPath);
    const { seal: again } = await restart();
    expect(again.status()).toEqual({ status: "untrusted", reason: "rollback" });
  });

  it("revocations.jsonl holds while running, not only at boot", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "lost-phone");
    seal.ensure();
    const { RevocationLedger } = await import("@psyche/permissions");
    // M-G: a line another program appended (unsigned) does not replay while running...
    pair(d, "other-phone");
    seal.ensure();
    new RevocationLedger(home).recordDevice("other-phone");
    // ...a line this Mac's seal signed does, at the next full check.
    new RevocationLedger(home, undefined, (l) => seal.signRevocation(l)).recordDevice("lost-phone");
    foreign((f) => setSetting(f, "appearance.theme", "dark"));
    seal.ensure();
    expect(getDevice(d, "lost-phone")?.revokedAt).not.toBeNull();
    expect(getDevice(d, "other-phone")?.revokedAt).toBeNull();
  });
});

describe("H6: a planted restore marker", () => {
  it("does not re-seal a tampered state", async () => {
    const d = db();
    await StateSeal.open(d, { home });
    pair(d, "owner-mac");
    for (const x of open.splice(0)) x.close();
    foreign((f) => {
      pair(f, "intruder");
      f.sqlite.prepare("DELETE FROM security_ledger").run();
    });
    for (const x of open.splice(0)) x.close();
    const d2 = db();
    const seal = await StateSeal.open(d2, { home, restored: true });
    expect(seal.status()).toEqual({ status: "untrusted", reason: "restore_unverified" });
    expect(seal.authorizeDevice(getDevice(d2, "intruder") as never)).toEqual({
      ok: true,
      scopes: ["operator.read"],
    });
  });

  it("never clears an untrusted state", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "x");
    seal.ensure();
    foreign((f) => f.sqlite.prepare("DELETE FROM security_ledger").run());
    seal.ensure();
    expect(seal.status().status).toBe("untrusted");
    for (const x of open.splice(0)) x.close();
    const again = await StateSeal.open(db(), { home, restored: true });
    expect(again.status().status).toBe("untrusted");
  });
});

describe("M1: a Gateway write never seals a change made outside", () => {
  it("refuses to update a row whose old state is not the genuine one", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "phone", ["operator.read"]);
    seal.ensure();
    foreign((f) =>
      f.sqlite
        .prepare(`UPDATE devices SET scopes = ? WHERE id = 'phone'`)
        .run(JSON.stringify(ADMIN)),
    );
    // A write straight on the connection, before any check (no read guard on this path).
    expect(() =>
      d.sqlite.prepare("UPDATE devices SET name = 'renamed' WHERE id = 'phone'").run(),
    ).toThrow(/changed outside Psyche/);
    seal.ensure();
    expect(getDevice(d, "phone")?.scopes).toEqual(["operator.read"]);
    updateDevice(d, "phone", { name: "renamed" });
    expect(getDevice(d, "phone")?.name).toBe("renamed");
  });
});

describe("M3: a corrupt key file", () => {
  it("is moved aside, a new key is made, and the state is untrusted (no crash)", async () => {
    const d = db();
    await StateSeal.open(d, { home });
    pair(d, "owner-mac");
    for (const x of open.splice(0)) x.close();
    writeFileSync(join(home, SEAL_KEY_FILE), "{not json");
    const { seal } = await restart();
    expect(seal.status()).toEqual({ status: "untrusted", reason: "key_corrupt" });
    expect(readdirSync(join(home, "security")).some((n) => n.includes(".corrupt-"))).toBe(true);
    expect(existsSync(join(home, SEAL_KEY_FILE))).toBe(true);
    const { seal: again } = await restart();
    expect(again.status().status).toBe("untrusted");
  });
});
