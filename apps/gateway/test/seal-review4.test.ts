import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteChannelStore } from "@psyche/channels";
import { type ConnectorRecord, SqliteConnectorStore } from "@psyche/connectors";
import {
  getDevice,
  getDeviceFamily,
  getSetting,
  insertDevice,
  openDb,
  type PsycheDb,
  setSetting,
  updateDevice,
} from "@psyche/db";
import { EverythingStore } from "@psyche/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecurityRecoveries } from "../src/security/recoveries.ts";
import { sealedChannelStore, sealedConnectorStore } from "../src/security/sealed-stores.ts";
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
 * The final verification of the seal (PR #1270): the reviewer's probes as regression tests. H1: a
 * Gateway write over a row nobody vouches for never becomes "verified"; H2 and M1: a restore is
 * the new baseline, and its marker vouches for one database, once; M2: narrowed channels are never
 * written back; M3: no spurious abort under repeated tampering; L1-L4.
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

async function restart(o: { restored?: boolean } = {}): Promise<{ d: PsycheDb; seal: StateSeal }> {
  for (const x of open.splice(0)) x.close();
  const d = db();
  return { d, seal: await StateSeal.open(d, { home, ...o }) };
}

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

const forgeSeal = () =>
  foreign((f) => f.sqlite.prepare("UPDATE security_seal SET agg = ?").run("00".repeat(32)));

function sealKey(): Buffer {
  const file = JSON.parse(readFileSync(join(home, SEAL_KEY_FILE), "utf8")) as { key: string };
  return Buffer.from(file.key, "base64");
}

function keyFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, SEAL_KEY_FILE), "utf8")) as Record<string, unknown>;
}

/** The seal row of a database file, as `psyche backup restore` reads it for the marker. */
function sealRowOf(path: string): { gen: number; mac: string } {
  const d = openDb(path, { migrate: false });
  try {
    return d.sqlite.prepare("SELECT gen, mac FROM security_seal WHERE id = 1").get() as {
      gen: number;
      mac: string;
    };
  } finally {
    d.close();
  }
}

/** What `@psyche/backup` writes after a restore on this Mac. */
function writeMarker(row: { gen: number; mac: string }): Record<string, string> {
  const marker: Record<string, string> = {
    restoredAt: new Date().toISOString(),
    backupCreatedAt: "b",
    sealGen: String(row.gen),
    sealRowMac: row.mac,
  };
  marker.mac = restoreMarkerMac(sealKey(), marker);
  writeFileSync(join(home, "security", "restored.json"), JSON.stringify(marker));
  return marker;
}

/** Puts a copy in place of the database, as a restore does (the Gateway is stopped). */
function putBack(copy: string) {
  for (const x of open.splice(0)) x.close();
  for (const f of readdirSync(join(home, "state"))) {
    if (f.startsWith("psyche.sqlite")) rmSync(join(home, "state", f));
  }
  renameSync(copy, dbPath);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "psyche-seal4-"));
  dbPath = join(home, "state", "psyche.sqlite");
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const d of open.splice(0)) d.close();
  await gw?.cleanup();
  gw = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe("H1: a Gateway write over a row nobody vouches for is never verified", () => {
  it("untrusted at run time: the planted device stays read-only after a restart, and a re-seal revokes it", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "owner");
    seal.ensure();
    forgeSeal();
    seal.ensure();
    expect(seal.status().status).toBe("untrusted");
    foreign((f) => pair(f, "intruder"));
    seal.ensure();
    // What a write at connect would do (the family pin; auth.ts now skips it, see below).
    updateDevice(d, "intruder", { deviceFamily: "desktop" });
    seal.ensure();
    seal.close();
    const { d: d2, seal: again } = await restart();
    expect(again.status().status).toBe("untrusted");
    expect(again.authorizeDevice(getDevice(d2, "intruder") as never)).toEqual({
      ok: true,
      scopes: ["operator.read"],
    });
    expect(again.authorizeDevice(getDevice(d2, "owner") as never)).toEqual({
      ok: true,
      scopes: ADMIN,
    });
    expect(again.reseal("recovery").neutralized).toBeGreaterThan(0);
    expect(getDevice(d2, "intruder")?.revokedAt).not.toBeNull();
    expect(getDevice(d2, "owner")?.revokedAt).toBeNull();
  });

  it("untrusted since boot: the same", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "owner");
    seal.ensure();
    seal.close();
    for (const x of open.splice(0)) x.close();
    forgeSeal();
    foreign((f) => pair(f, "intruder"));
    const { d: d1, seal: s1 } = await restart();
    expect(s1.status()).toEqual({ status: "untrusted", reason: "seal_forged" });
    expect(s1.authorizeDevice(getDevice(d1, "intruder") as never)).toEqual({
      ok: true,
      scopes: ["operator.read"],
    });
    updateDevice(d1, "intruder", { deviceFamily: "desktop", name: "Owner's iPhone" });
    s1.ensure();
    s1.close();
    const { d: d2, seal: s2 } = await restart();
    expect(s2.authorizeDevice(getDevice(d2, "intruder") as never)).toEqual({
      ok: true,
      scopes: ["operator.read"],
    });
    expect(s2.genuine("devices", "intruder")).toBe(false);
    s2.reseal("recovery");
    expect(getDevice(d2, "intruder")?.revokedAt).not.toBeNull();
    expect(getDevice(d2, "owner")?.revokedAt).toBeNull();
  });

  it("the device-family pin at connect is skipped for a device the seal cannot vouch for", async () => {
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
    expect(getDeviceFamily(g.context.db, "intruder")).toBeNull();
  });
});

describe("H2 and M1: a verified restore", () => {
  it("is the new baseline: the next ordinary start is sealed, not a rollback", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "owner");
    seal.ensure();
    const copy = join(home, "copy.sqlite");
    d.sqlite.prepare("VACUUM INTO ?").run(copy);
    for (let i = 0; i < 5; i++) pair(d, `later${i}`);
    seal.close();
    putBack(copy);
    writeMarker(sealRowOf(dbPath));
    const { d: d3, seal: s3 } = await restart({ restored: true });
    expect(s3.status().status).toBe("sealed");
    pair(d3, "after-restore");
    s3.ensure();
    s3.close();
    rmSync(join(home, "security", "restored.json"));
    const { seal: s4 } = await restart();
    expect(s4.status()).toEqual({ status: "sealed", reason: null });
  });

  it("restarts every waiting recovery's 24 hours", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    const soon = new Date(Date.now() + 60_000).toISOString();
    d.sqlite
      .prepare(
        "INSERT INTO security_recoveries (id, op, params, status, seen_at, not_before, created_at, updated_at) VALUES ('w', 'presence.reset', '{}', 'waiting', ?, ?, ?, ?)",
      )
      .run(d.now(), soon, d.now(), d.now());
    const copy = join(home, "copy.sqlite");
    d.sqlite.prepare("VACUUM INTO ?").run(copy);
    seal.close();
    putBack(copy);
    writeMarker(sealRowOf(dbPath));
    const { d: d2, seal: s2 } = await restart({ restored: true });
    expect(s2.status().status).toBe("sealed");
    const notBefore = d2.sqlite
      .prepare("SELECT not_before FROM security_recoveries WHERE id = 'w'")
      .pluck()
      .get() as string;
    expect(Date.parse(notBefore)).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it("a marker vouches for the database it names only", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "owner");
    const older = join(home, "older.sqlite");
    d.sqlite.prepare("VACUUM INTO ?").run(older);
    pair(d, "later");
    const newer = join(home, "newer.sqlite");
    d.sqlite.prepare("VACUUM INTO ?").run(newer);
    pair(d, "latest");
    seal.close();
    // A marker made for the newer backup, put next to the older one.
    const named = sealRowOf(newer);
    putBack(older);
    writeMarker(named);
    const { seal: s2 } = await restart({ restored: true });
    expect(s2.status()).toEqual({ status: "untrusted", reason: "restore_unverified" });
  });

  it("a marker works once: replayed with the same old database later, it is a rollback", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "owner");
    const copy = join(home, "copy.sqlite");
    d.sqlite.prepare("VACUUM INTO ?").run(copy);
    const spare = join(home, "spare.sqlite");
    d.sqlite.prepare("VACUUM INTO ?").run(spare);
    pair(d, "later");
    seal.close();
    putBack(copy);
    const marker = writeMarker(sealRowOf(dbPath));
    const { d: d2, seal: s2 } = await restart({ restored: true });
    expect(s2.status().status).toBe("sealed");
    expect(keyFile().usedRestoreMarkers).toContain(marker.mac);
    for (let i = 0; i < 3; i++) pair(d2, `new${i}`);
    s2.close();
    // Another program saved the marker and puts the same old database back with it.
    putBack(spare);
    writeFileSync(join(home, "security", "restored.json"), JSON.stringify(marker));
    const { seal: s3 } = await restart({ restored: true });
    expect(s3.status()).toEqual({ status: "untrusted", reason: "restore_unverified" });
  });
});

describe("M2: a narrowed channel is never written back", () => {
  it("a status save keeps the stored allowlists; other edits wait; the reader narrows", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    const store = sealedChannelStore(new SqliteChannelStore(d), seal, () => seal.ensure());
    const channel = (id: string, account: string, allowFrom: string[]) => ({
      id,
      type: "telegram" as const,
      account,
      dmPolicy: "allowlist" as const,
      allowFrom,
      groupAllowFrom: [],
      requireMention: true,
      ownerIds: [],
      dmScope: "per-channel-peer" as const,
      nodeId: null,
      status: "active" as const,
      config: {},
      createdAt: d.now(),
      updatedAt: d.now(),
    });
    await store.saveChannel(channel("mine", "bot1", ["owner"]) as never);
    forgeSeal();
    seal.ensure();
    expect(seal.status().status).toBe("untrusted");
    const planted = channel("evil", "bot2", ["+15550000"]);
    await foreign((f) => new SqliteChannelStore(f).saveChannel(planted as never));
    const listed = await store.listChannels();
    expect(listed.find((c) => c.id === "mine")?.allowFrom).toEqual(["owner"]);
    const evil = listed.find((c) => c.id === "evil");
    expect(evil).toMatchObject({ dmPolicy: "disabled", allowFrom: [], ownerIds: [] });
    // What ChannelService.#setStatus does with its cached (narrowed) copy.
    await store.saveChannel({ ...evil, status: "error", updatedAt: d.now() } as never);
    const raw = d.sqlite
      .prepare("SELECT allow_from, dm_policy, status FROM channels WHERE id = 'evil'")
      .get() as { allow_from: string; dm_policy: string; status: string };
    expect(raw).toEqual({ allow_from: '["+15550000"]', dm_policy: "allowlist", status: "error" });
    await expect(
      store.saveChannel({ ...evil, allowFrom: ["someone"] } as never),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("the one rule through the real readers", () => {
  it("connectors: a row the seal cannot vouch for is not in the registry's store (L1)", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    const store = sealedConnectorStore(new SqliteConnectorStore(d.sqlite), seal);
    const record = (id: string): ConnectorRecord => ({
      id,
      type: "web_fetch",
      label: id,
      account: null,
      scopes: [],
      scopeMode: "read_act",
      actionMatrix: {},
      credentialId: null,
      status: "connected",
      config: {},
      lastSync: null,
      createdAt: d.now(),
      updatedAt: d.now(),
    });
    await store.put(record("mine"));
    forgeSeal();
    seal.ensure();
    await foreign((f) => new SqliteConnectorStore(f.sqlite).put(record("planted")));
    expect((await store.list()).map((r) => r.id)).toEqual(["mine"]);
    expect(await store.get("planted")).toBeUndefined();
    expect((await store.get("mine"))?.id).toBe("mine");
  });

  it("memory: isTrustedSender trusts only a row the seal vouches for", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    d.sqlite.pragma("foreign_keys = OFF");
    d.sqlite
      .prepare(
        "INSERT INTO memory_trusted_senders (entity_id, state, decided_at) VALUES ('friend', 'trusted', ?)",
      )
      .run(d.now());
    d.sqlite.pragma("foreign_keys = ON");
    seal.ensure();
    forgeSeal();
    seal.ensure();
    foreign((f) => {
      f.sqlite.pragma("foreign_keys = OFF");
      f.sqlite
        .prepare(
          "INSERT INTO memory_trusted_senders (entity_id, state, decided_at) VALUES ('evil', 'trusted', ?)",
        )
        .run(f.now());
    });
    const store = new EverythingStore({ sqlite: d.sqlite, graph: {} as never });
    expect(store.isTrustedSender("friend")).toBe(true);
    expect(store.isTrustedSender("evil")).toBe(false);
  });

  it("settings, untrusted since boot: a security setting reads its verified value, others as stored", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "spare");
    setSetting(d, "_lan.networks", ["en0"]);
    setSetting(d, "model.default", "a/model");
    seal.close();
    for (const x of open.splice(0)) x.close();
    foreign((f) => {
      // The ledger no longer adds up (untrusted since boot); each other entry still verifies.
      f.sqlite.prepare("DELETE FROM security_ledger WHERE pk = 'spare'").run();
      setSetting(f, "_lan.networks", ["en0", "utun9"]);
      setSetting(f, "model.default", "b/model");
      setSetting(f, "exec.host.enabled", true);
    });
    const { d: d2, seal: s2 } = await restart();
    expect(s2.status()).toEqual({ status: "untrusted", reason: "ledger_mismatch" });
    const raw = d2.sqlite
      .prepare("SELECT value FROM settings WHERE key = '_lan.networks'")
      .pluck()
      .get();
    expect(JSON.parse(String(raw))).toEqual(["en0", "utun9"]);
    expect(getSetting(d2, "_lan.networks")?.value).toEqual(["en0"]);
    expect(getSetting(d2, "exec.host.enabled")).toBeUndefined();
    expect(getSetting(d2, "model.default")?.value).toBe("b/model");
  });
});

describe("M3: repeated tampering", () => {
  it("a second tamper racing the alert's notification neither aborts nor sticks", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "phone", ["operator.read"]);
    seal.ensure();
    const widen = () =>
      foreign((f) =>
        f.sqlite
          .prepare("UPDATE devices SET scopes = ? WHERE id = 'phone'")
          .run(JSON.stringify(ADMIN)),
      );
    widen();
    seal.ensure();
    const alert = seal.alerts.open().find((a) => a.kind === "state_changed_outside");
    expect(alert).toBeDefined();
    widen();
    seal.alerts.markNotified(alert?.id ?? "");
    expect(() => seal.ensure()).not.toThrow();
    expect(seal.status().status).toBe("sealed");
    expect(getDevice(d, "phone")?.scopes).toEqual(["operator.read"]);
    expect(seal.driftCount()).toBe(0);
    expect(() => seal.alerts.add("state_changed_outside", {})).not.toThrow();
    expect(
      seal.alerts.open().find((a) => a.kind === "state_changed_outside")?.details.occurrences,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("L3: the seal's own tables", () => {
  it.each(["security_ledger", "security_seal"])(
    "a dropped %s is put back and the state is untrusted, not a crash",
    async (table) => {
      const d = db();
      const seal = await StateSeal.open(d, { home });
      pair(d, "owner");
      seal.close();
      for (const x of open.splice(0)) x.close();
      foreign((f) => f.sqlite.exec(`DROP TABLE ${table}`));
      const { d: d2, seal: s2 } = await restart();
      expect(s2.status()).toEqual({ status: "untrusted", reason: "schema_tampered" });
      expect(s2.authorizeDevice(getDevice(d2, "owner") as never).ok).toBe(true);
      expect(() => s2.ensure()).not.toThrow();
    },
  );
});

describe("L4: Mac cancels are counted outside the database too", () => {
  it("deleting the cancel alerts does not lower the count", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    const rec = new SecurityRecoveries({
      db: d,
      seal,
      now: () => new Date(),
      presence: { state: () => "unavailable", forget: () => undefined },
    });
    const request = (id: string, target: string) =>
      d.sqlite
        .prepare(
          "INSERT INTO security_requests (id, op, params, status, created_at, updated_at) VALUES (?, 'recovery.cancel', ?, 'new', ?, ?)",
        )
        .run(id, JSON.stringify({ id: target }), d.now(), d.now());
    for (let i = 0; i < 5; i++) {
      d.sqlite
        .prepare(
          "INSERT INTO security_recoveries (id, op, params, status, seen_at, not_before, created_at, updated_at) VALUES (?, 'presence.reset', '{}', 'waiting', ?, ?, ?, ?)",
        )
        .run(`w${i}`, d.now(), d.now(), d.now(), d.now());
      request(`c${i}`, `w${i}`);
    }
    rec.processInbox();
    expect(seal.macCancelsSince(new Date(Date.now() - 60_000).toISOString())).toBe(5);
    d.sqlite.prepare("DELETE FROM security_alerts WHERE kind = 'recovery_cancelled'").run();
    request("c5", "w0");
    rec.processInbox();
    expect(
      d.sqlite.prepare("SELECT outcome FROM security_requests WHERE id = 'c5'").pluck().get(),
    ).toMatch(/too many cancels/);
  });
});
