import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDevice,
  getSetting,
  hashSetupToken,
  insertDevice,
  openDb,
  type PsycheDb,
  revokeDevice,
  setSetting,
} from "@psyche/db";
import { RevocationLedger } from "@psyche/permissions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecurityRecoveries } from "../src/security/recoveries.ts";
import { restoreMarkerMac, SEAL_KEY_FILE, StateSeal } from "../src/security/state-seal.ts";
import {
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
 * The third review of the seal (PR #1270, H-A to H-D, M-A to M-G): one rule while untrusted (only
 * rows the Gateway can vouch for authorize anything), a re-seal that adopts nothing that grants
 * access, and the stickiness of decisions across rollbacks.
 */

let home = "";
let dbPath = "";
const open: PsycheDb[] = [];
let gw: TestGateway | undefined;
const clients: TestClient[] = [];

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

const PLANTED = `pst_${"A".repeat(43)}`;
const ADMIN = ["operator.read", "operator.write", "operator.approvals", "operator.admin"];

function pair(d: PsycheDb, id: string, scopes: string[] = ADMIN) {
  insertDevice(d, {
    id,
    name: `device ${id}`,
    platform: "macos",
    role: "client",
    publicKey: Buffer.alloc(32, id.length + id.charCodeAt(0)),
    scopes: scopes as never,
    pairedAt: d.now(),
  });
}

/** Breaks the ledger (one entry gone): untrusted, and after a restart untrusted since boot. */
function breakLedger(pk: string) {
  foreign((f) => f.sqlite.prepare("DELETE FROM security_ledger WHERE pk = ?").run(pk));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "psyche-seal3-"));
  dbPath = join(home, "state", "psyche.sqlite");
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const d of open.splice(0)) d.close();
  await gw?.cleanup();
  gw = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe("H-A: a re-seal adopts nothing that grants access", () => {
  it("revokes devices it cannot vouch for, keeps the owner's, and lists adopted settings", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "owner");
    pair(d, "spare");
    seal.ensure();
    breakLedger("spare");
    seal.ensure();
    expect(seal.status().status).toBe("untrusted");
    foreign((f) => {
      pair(f, "intruder");
      setSetting(f, "model.default", "attacker/model"); // not a security setting: adopted
      setSetting(f, "exec.host.enabled", true); // a security setting: not adopted
    });
    const { d: d2, seal: again } = await restart();
    expect(again.status().status).toBe("untrusted");
    // The owner's device has a verified ledger entry: it keeps admin (and may cancel a re-seal).
    expect(again.authorizeDevice(getDevice(d2, "owner") as never)).toEqual({
      ok: true,
      scopes: ADMIN,
    });
    expect(again.authorizeDevice(getDevice(d2, "intruder") as never)).toEqual({
      ok: true,
      scopes: ["operator.read"],
    });
    const out = again.reseal("recovery");
    expect(out.neutralized).toBeGreaterThan(0);
    expect(again.status().status).toBe("sealed");
    expect(getDevice(d2, "intruder")?.revokedAt).not.toBeNull();
    // "spare" lost its entry: it cannot be vouched for, so it is revoked too (the owner re-pairs).
    expect(getDevice(d2, "spare")?.revokedAt).not.toBeNull();
    expect(getDevice(d2, "owner")?.revokedAt).toBeNull();
    expect(getSetting(d2, "exec.host.enabled")).toBeUndefined();
    expect(getSetting(d2, "model.default")?.value).toBe("attacker/model");
    const adopted = again.alerts.open().find((a) => a.details.reason === "adopted_at_reseal");
    expect(adopted?.details.changes?.map((c) => c.name)).toContain("model.default");
  });

  it("a re-seal can be cancelled by a device the seal vouches for, never from the Mac", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "owner");
    breakLedger("none");
    foreign((f) => f.sqlite.prepare("UPDATE security_seal SET agg = ?").run("00".repeat(32)));
    seal.ensure();
    const rec = new SecurityRecoveries({
      db: d,
      seal,
      now: () => new Date(),
      presence: { state: () => "unavailable", forget: () => undefined },
    });
    d.sqlite
      .prepare(
        "INSERT INTO security_requests (id, op, params, status, created_at, updated_at) VALUES ('r1', 'seal.reset', '{}', 'new', ?, ?)",
      )
      .run(d.now(), d.now());
    rec.processInbox();
    const [waiting] = rec.list();
    expect(() => rec.cancel(waiting?.id ?? "", null)).toThrow(/only from an admin device/);
    const owner = seal.authorizeDevice(getDevice(d, "owner") as never);
    expect(owner.ok && owner.scopes.includes("operator.admin")).toBe(true);
    expect(rec.cancel(waiting?.id ?? "", "owner", { trustedAdmin: true }).status).toBe("cancelled");
  });
});

describe("H-B: no pairing link works while untrusted", () => {
  it("a planted setup token is refused", async () => {
    gw = await startTestGateway({
      home,
      config: { dbPath },
      security: { pollMs: 0 },
    });
    const g = gw.gateway;
    const other = openDb(dbPath, { migrate: false });
    other.sqlite.prepare("UPDATE security_seal SET agg = ?").run("00".repeat(32));
    other.sqlite
      .prepare(
        `INSERT INTO setup_tokens (id, token_hash, scopes, created_at, expires_at)
         VALUES ('t1', ?, '["operator.admin"]', ?, ?)`,
      )
      .run(hashSetupToken(PLANTED), other.now(), new Date(Date.now() + 600_000).toISOString());
    other.close();
    g.context.securityState?.ensure();
    expect(g.context.securityState?.status().status).toBe("untrusted");
    const c = await Client.open(wsUrlOf(g));
    clients.push(c);
    const res = await handshake(c, g.origin, {
      key: newDeviceKey(),
      deviceId: "linker",
      gatewayKey: g.context.identity.publicKey,
      setupToken: PLANTED,
    });
    expect(res.challengeRes).toMatchObject({ ok: true });
    expect(verified<{ phase: string; code?: string }>(res)).toMatchObject({
      phase: "denied",
      code: "setup_token_invalid",
    });
  });
});

describe("H-C: a device the seal cannot vouch for gets no narrowing calls either", () => {
  it("an inserted device is read-only: no devices.revoke on stored scopes", async () => {
    gw = await startTestGateway({ home, config: { dbPath }, security: { pollMs: 0 } });
    const g = gw.gateway;
    const key = newDeviceKey();
    const other = openDb(dbPath, { migrate: false });
    other.sqlite.prepare("UPDATE security_seal SET agg = ?").run("00".repeat(32));
    insertDevice(other, {
      id: "intruder",
      name: "intruder",
      platform: "macos",
      role: "client",
      publicKey: key.publicKey,
      scopes: ADMIN as never,
      pairedAt: other.now(),
    });
    other.close();
    const c = await Client.open(wsUrlOf(g));
    clients.push(c);
    const res = await handshake(c, g.origin, { key, deviceId: "intruder" });
    expect(verified<{ phase: string; scopes: string[] }>(res)).toMatchObject({
      phase: "paired",
      scopes: ["operator.read"],
    });
    expect(await c.request("devices.revoke", { deviceId: "intruder" }, "k1")).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
  });
});

describe("H-D: a failed repair adopts nothing", () => {
  it("rows a repair wrote before it failed are not folded into the copy", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "phone", ["operator.read"]);
    seal.ensure();
    // A widened device, plus a trigger (on the Gateway's own connection, so allowed) that makes
    // every repair of devices fail half way.
    foreign((f) =>
      f.sqlite
        .prepare(`UPDATE devices SET scopes = ? WHERE id = 'phone'`)
        .run(JSON.stringify(ADMIN)),
    );
    d.sqlite.exec(
      "CREATE TRIGGER fail_repairs AFTER UPDATE ON devices BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    seal.ensure();
    expect(seal.status()).toEqual({ status: "untrusted", reason: "repair_failed" });
    d.sqlite.exec("DROP TRIGGER fail_repairs");
    // The widened scopes are not taken as the Gateway's own.
    expect(seal.authorizeDevice(getDevice(d, "phone") as never)).toEqual({
      ok: true,
      scopes: ["operator.read"],
    });
  });

  it("a repair parks unique values another program moved, so it does not fail", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "a");
    pair(d, "b");
    d.sqlite.prepare("UPDATE devices SET token_hash = x'aa' WHERE id = 'a'").run();
    d.sqlite.prepare("UPDATE devices SET token_hash = x'bb' WHERE id = 'b'").run();
    seal.ensure();
    foreign((f) => {
      f.sqlite.prepare("UPDATE devices SET token_hash = x'cc' WHERE id = 'a'").run();
      f.sqlite.prepare("UPDATE devices SET token_hash = x'aa' WHERE id = 'b'").run();
    });
    seal.ensure();
    expect(seal.status().status).toBe("sealed");
    expect(
      d.sqlite.prepare("SELECT hex(token_hash) FROM devices WHERE id = 'a'").pluck().get(),
    ).toBe("AA");
    expect(
      d.sqlite.prepare("SELECT hex(token_hash) FROM devices WHERE id = 'b'").pluck().get(),
    ).toBe("BB");
  });
});

describe("M-A: decisions and restores", () => {
  it("a cancelled recovery brought back by a rollback is never applied", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "owner");
    const rec = new SecurityRecoveries({
      db: d,
      seal,
      now: () => new Date(Date.now() + 2 * 86_400_000),
      presence: { state: () => "unavailable", forget: () => undefined },
    });
    d.sqlite
      .prepare(
        "INSERT INTO security_recoveries (id, op, params, status, seen_at, not_before, created_at, updated_at) VALUES ('rc', 'presence.reset', '{}', 'waiting', ?, ?, ?, ?)",
      )
      .run(d.now(), d.now(), d.now(), d.now());
    rec.cancel("rc", "owner");
    // Another program puts the row back to waiting (with a valid-looking ledger it could replay).
    d.sqlite.prepare("UPDATE security_recoveries SET status = 'waiting' WHERE id = 'rc'").run();
    expect(seal.recoveryDecided("rc")).toBe(true);
    expect(rec.applyDue()).toBe(0);
  });

  it("an unsigned restore marker keeps the rollback check; a signed one restarts waiting clocks", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "owner");
    const copy = join(home, "copy.sqlite");
    d.sqlite.prepare("VACUUM INTO ?").run(copy);
    pair(d, "later");
    seal.close();
    for (const x of open.splice(0)) x.close();
    const { renameSync, readdirSync } = await import("node:fs");
    for (const f of readdirSync(join(home, "state"))) rmSync(join(home, "state", f));
    renameSync(copy, dbPath);
    writeFileSync(join(home, "security", "restored.json"), JSON.stringify({ restoredAt: "x" }));
    const unsigned = await StateSeal.open(db(), { home, restored: true });
    expect(unsigned.status()).toEqual({ status: "untrusted", reason: "restore_unverified" });
  });

  it("a signed marker from this Mac verifies, and the restore alert is a warning", async () => {
    const d = db();
    await StateSeal.open(d, { home });
    pair(d, "owner");
    for (const x of open.splice(0)) x.close();
    const key = Buffer.from(
      (JSON.parse(readFileSync(join(home, SEAL_KEY_FILE), "utf8")) as { key: string }).key,
      "base64",
    );
    const row = foreign(
      (f) =>
        f.sqlite.prepare("SELECT gen, mac FROM security_seal WHERE id = 1").get() as {
          gen: number;
          mac: string;
        },
    );
    // The marker names the restored database's seal row (M1 of the final review).
    const marker: Record<string, string> = {
      restoredAt: "a",
      backupCreatedAt: "b",
      sealGen: String(row.gen),
      sealRowMac: row.mac,
    };
    marker.mac = restoreMarkerMac(key, marker);
    writeFileSync(join(home, "security", "restored.json"), JSON.stringify(marker));
    const seal = await StateSeal.open(db(), { home, restored: true });
    expect(seal.status().status).toBe("sealed");
    expect(seal.alerts.open().find((a) => a.kind === "state_resealed")?.severity).toBe("warning");
  });
});

describe("M-B: untrusted survives a rollback of the database", () => {
  it("is recorded in the key file", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    const copy = join(home, "copy.sqlite");
    pair(d, "owner");
    seal.ensure();
    d.sqlite.prepare("VACUUM INTO ?").run(copy);
    breakLedger("owner");
    seal.ensure();
    expect(seal.status().status).toBe("untrusted");
    for (const x of open.splice(0)) x.close();
    const { renameSync, readdirSync } = await import("node:fs");
    for (const f of readdirSync(join(home, "state"))) rmSync(join(home, "state", f));
    renameSync(copy, dbPath); // the copy is consistent and says "sealed"
    const { seal: again } = await restart();
    expect(again.status().status).toBe("untrusted");
  });
});

describe("M-C: the generation the Gateway produced is the floor at once", () => {
  it("a rollback right after a Gateway write (before any check) is caught", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "phone");
    seal.ensure();
    const snap = foreign((f) =>
      ["devices", "security_ledger", "security_seal"].map(
        (t) => [t, f.sqlite.prepare(`SELECT * FROM ${t}`).all()] as const,
      ),
    );
    revokeDevice(d, "phone"); // committed; no ensure() between it and the rollback
    foreign((f) => {
      f.sqlite.pragma("foreign_keys = OFF");
      f.sqlite.transaction(() => {
        for (const [t, rows] of snap) {
          f.sqlite.prepare(`DELETE FROM ${t}`).run();
          for (const r of rows as Record<string, unknown>[]) {
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
    expect(getDevice(d, "phone")?.revokedAt).not.toBeNull();
  });
});

describe("M-D: reads that authorize, while untrusted", () => {
  it("security settings read only what the Gateway can vouch for; a trusted sender row too", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    setSetting(d, "_lan.networks", ["en0"]);
    seal.ensure();
    breakLedger("none");
    foreign((f) => f.sqlite.prepare("UPDATE security_seal SET agg = ?").run("00".repeat(32)));
    seal.ensure();
    foreign((f) => {
      setSetting(f, "_lan.networks", ["en0", "utun9"]);
      f.sqlite.pragma("foreign_keys = OFF");
      f.sqlite
        .prepare(
          "INSERT INTO memory_trusted_senders (entity_id, state, decided_at) VALUES ('evil', 'trusted', ?)",
        )
        .run(f.now());
    });
    expect(getSetting(d, "_lan.networks")?.value).toEqual(["en0"]);
    expect(seal.genuine("memory_trusted_senders", "evil")).toBe(false);
  });
});

describe("M-E: the local first-admin shortcut applies only the admin-making request", () => {
  it("a non-admin approval while no admin exists waits", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    const rec = new SecurityRecoveries({
      db: d,
      seal,
      now: () => new Date(),
      presence: { state: () => "off", forget: () => undefined },
    });
    insertDevice(d, {
      id: "node1",
      name: "node",
      platform: "macos",
      role: "node",
      publicKey: Buffer.alloc(32, 3),
      scopes: [],
      pairedAt: d.now(),
    });
    d.sqlite
      .prepare(
        "INSERT INTO security_requests (id, op, params, status, created_at, updated_at) VALUES ('g', 'devices.grant', ?, 'new', ?, ?)",
      )
      .run(JSON.stringify({ deviceId: "node1", scopes: ["node"] }), d.now(), d.now());
    rec.processInbox();
    expect(getDevice(d, "node1")?.scopes).toEqual([]);
    expect(rec.list()[0]?.status).toBe("waiting");
  });
});

describe("M-F: Mac cancels are counted from the sealed alerts", () => {
  it("the cap holds across a restart of the recoveries", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    for (let i = 0; i < 5; i++) seal.alerts.add("recovery_cancelled", { via: "mac" });
    const rec = new SecurityRecoveries({
      db: d,
      seal,
      now: () => new Date(),
      presence: { state: () => "unavailable", forget: () => undefined },
    });
    d.sqlite
      .prepare(
        "INSERT INTO security_requests (id, op, params, status, created_at, updated_at) VALUES ('c', 'recovery.cancel', '{\"id\":\"x\"}', 'new', ?, ?)",
      )
      .run(d.now(), d.now());
    rec.processInbox();
    expect(
      d.sqlite.prepare("SELECT outcome FROM security_requests WHERE id = 'c'").pluck().get(),
    ).toMatch(/too many cancels/);
  });
});

describe("M-G: revocation lines are signed", () => {
  it("lines this Mac's seal signed carry a MAC; others do not", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    new RevocationLedger(home, undefined, (l) => seal.signRevocation(l)).recordDevice("x");
    new RevocationLedger(home).recordDevice("y");
    const entries = new RevocationLedger(home).entries();
    expect(entries.find((e) => e.type === "device" && e.id === "x")?.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(entries.find((e) => e.type === "device" && e.id === "y")?.mac).toBeUndefined();
  });
});
