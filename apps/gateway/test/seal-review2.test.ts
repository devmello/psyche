import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDevice,
  getSetting,
  insertDevice,
  openDb,
  type PsycheDb,
  revokeDevice,
  setSetting,
  touchLastSeen,
  updateDevice,
} from "@psyche/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateSeal } from "../src/security/state-seal.ts";

/**
 * The second review of the seal (PR #1270): the schema allowlist and the check before every
 * Gateway write, drift of the in-memory copy (rollbacks, half-failed writes, re-entrant checks),
 * normal writes never aborting (a soak with every kind of write), D10 pruning, and boot without a
 * writable `security/`.
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
const count = (d: PsycheDb, sql: string) => d.sqlite.prepare(sql).pluck().get() as number;

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
    publicKey: Buffer.alloc(32, id.length + id.charCodeAt(0)),
    scopes: scopes as never,
    pairedAt,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "psyche-seal2-"));
  dbPath = join(home, "state", "psyche.sqlite");
});

afterEach(() => {
  for (const d of open.splice(0)) d.close();
  try {
    chmodSync(join(home, "security"), 0o700);
  } catch {
    // not made
  }
  rmSync(home, { recursive: true, force: true });
});

describe("concern 1: the schema is checked before every Gateway write", () => {
  it("a trigger planted since the last check never fires on the next Gateway write", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "intruder", [], null);
    seal.ensure();
    foreign((f) =>
      f.sqlite.exec(`CREATE TRIGGER t_quiet AFTER INSERT ON settings
        BEGIN UPDATE devices SET scopes = '["operator.admin"]', paired_at = NEW.updated_at WHERE id = 'intruder'; END`),
    );
    // No ensure(): the very next write (a routine counter) is checked before it runs.
    setSetting(d, "_gateway.stateVersion", 7);
    expect(count(d, "SELECT count(*) FROM sqlite_master WHERE name = 't_quiet'")).toBe(0);
    expect(d.sqlite.prepare("SELECT scopes FROM devices WHERE id = 'intruder'").pluck().get()).toBe(
      "[]",
    );
    expect(seal.status()).toEqual({ status: "untrusted", reason: "schema_tampered" });
  });

  it("inside an open transaction the write is refused instead", async () => {
    const d = db();
    await StateSeal.open(d, { home });
    foreign((f) =>
      f.sqlite.exec("CREATE TRIGGER t_tx AFTER INSERT ON settings BEGIN SELECT 1; END"),
    );
    expect(() =>
      d.sqlite.transaction(() => d.sqlite.prepare("INSERT INTO usage (id) VALUES ('x')").run())(),
    ).toThrow(/schema changed outside/);
  });
});

describe("concern 2: an allowlist, not a name blocklist", () => {
  it("drops an extra trigger whose name and body mention nothing security-related", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    foreign((f) =>
      f.sqlite.exec(
        "CREATE TRIGGER harmless_looking AFTER INSERT ON usage BEGIN DELETE FROM usage WHERE 0; END",
      ),
    );
    seal.ensure();
    expect(count(d, "SELECT count(*) FROM sqlite_master WHERE name = 'harmless_looking'")).toBe(0);
    expect(seal.status().reason).toBe("schema_tampered");
  });

  it("drops a planted index and puts back a known trigger whose body was swapped", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    const original = d.sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_chunks_fts_insert'")
      .pluck()
      .get() as string;
    expect(original).toMatch(/CREATE TRIGGER/);
    foreign((f) => {
      f.sqlite.exec("CREATE INDEX planted_idx ON devices (name)");
      f.sqlite.exec("DROP TRIGGER memory_chunks_fts_insert");
      f.sqlite.exec(
        "CREATE TRIGGER memory_chunks_fts_insert AFTER INSERT ON memory_chunks BEGIN SELECT 1; END",
      );
    });
    seal.ensure();
    expect(count(d, "SELECT count(*) FROM sqlite_master WHERE name = 'planted_idx'")).toBe(0);
    expect(
      d.sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_chunks_fts_insert'")
        .pluck()
        .get(),
    ).toBe(original);
    expect(seal.status().reason).toBe("schema_tampered");
  });

  it("the Gateway's own DDL at run time is learned, sealed, and still allowed after a restart", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    d.sqlite.exec("CREATE TABLE IF NOT EXISTS runtime_docs (id TEXT)");
    d.sqlite.exec("CREATE INDEX IF NOT EXISTS runtime_docs_idx ON runtime_docs (id)");
    d.sqlite.exec(
      "CREATE TRIGGER IF NOT EXISTS runtime_docs_ai AFTER INSERT ON runtime_docs BEGIN SELECT 1; END",
    );
    seal.ensure();
    expect(seal.status().status).toBe("sealed");
    const { seal: again } = await restart();
    expect(again.status().status).toBe("sealed");
  });

  it("an upgrade's first seal accepts what was already there (search triggers from earlier runs)", async () => {
    const pre = openDb(dbPath);
    pre.sqlite.exec("CREATE TABLE earlier_docs (id TEXT)");
    pre.sqlite.exec("CREATE TRIGGER earlier_ai AFTER INSERT ON earlier_docs BEGIN SELECT 1; END");
    pre.close();
    const seal = await StateSeal.open(db(), { home });
    expect(seal.status().status).toBe("sealed");
    const { seal: again } = await restart();
    expect(again.status().status).toBe("sealed");
  });
});

describe("concern 3: the in-memory copy follows commits only", () => {
  it("a rolled-back transaction leaves no drift and no false alarm", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "phone", ["operator.read"]);
    seal.ensure();
    expect(() =>
      d.sqlite.transaction(() => {
        updateDevice(d, "phone", { scopes: ADMIN as never });
        setSetting(d, "permissions.policy", { deny: [] });
        throw new Error("handler failed");
      })(),
    ).toThrow(/handler failed/);
    expect(seal.driftCount()).toBe(0);
    foreign((f) => setSetting(f, "appearance.theme", "dark")); // forces a full check
    seal.ensure();
    expect(seal.status().status).toBe("sealed");
    expect(seal.alerts.open()).toEqual([]);
    expect(getDevice(d, "phone")?.scopes).toEqual(["operator.read"]);
    // And the next write over the same row is not refused.
    updateDevice(d, "phone", { name: "renamed" });
  });

  it("a write that fails halfway (the second row hits a constraint) leaves no drift", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "a");
    pair(d, "b");
    seal.ensure();
    expect(() =>
      d.sqlite.prepare("UPDATE devices SET token_hash = x'01', updated_at = 'x'").run(),
    ).toThrow(/UNIQUE/);
    expect(seal.driftCount()).toBe(0);
    foreign((f) => setSetting(f, "appearance.theme", "dark"));
    seal.ensure();
    expect(seal.status().status).toBe("sealed");
    expect(seal.alerts.open()).toEqual([]);
  });

  it("ensure() called again from a listener is run once more afterwards, and catches a change made meanwhile", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    pair(d, "phone", ["operator.read"]);
    seal.ensure();
    let once = true;
    seal.alerts.onAlert(() => {
      // A notifier reading a setting (re-entrant), while another program writes again.
      expect(getSetting(d, "permissions.policy")).toBeUndefined();
      if (once) {
        once = false;
        foreign((f) => pair(f, "second-rogue"));
      }
    });
    foreign((f) => pair(f, "rogue"));
    seal.ensure();
    expect(getDevice(d, "rogue")?.revokedAt).not.toBeNull();
    expect(getDevice(d, "second-rogue")?.revokedAt).not.toBeNull();
    expect(seal.driftCount()).toBe(0);
  });
});

describe("concern 4: normal writes from every package never abort", () => {
  it("a soak of device activity, approvals, grant use, upserts, cascades, alerts and pruning", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    const now = () => d.now();
    for (let i = 0; i < 8; i++) pair(d, `dev${i}`, ["operator.read", "operator.write"]);
    const approval = (id: string) =>
      d.sqlite
        .prepare(
          `INSERT INTO approvals (id, kind, summary, details, binding_hash, grant_key, device_only, requires_authentication,
             taint, surfaces, scopes_offered, answer_tokens, status, request_input, boot_id, requested_at, expires_at,
             created_at, updated_at)
           VALUES (?, 'site', 's', '{}', 'b', 'k', 0, 0, 0, '[]', '[]', '[]', 'pending', '{}', 'boot', ?, ?, ?, ?)`,
        )
        .run(id, now(), now(), now(), now());
    const grant = (id: string, approvalId: string) =>
      d.sqlite
        .prepare(
          `INSERT INTO grants (id, kind, scope, grant_key, subject, side_effect, created_from_approval_id, created_at, updated_at)
           VALUES (?, 'site', 'always', 'k', '{}', 'read', ?, ?, ?)`,
        )
        .run(id, approvalId, now(), now());
    let aborts = 0;
    const act = (fn: () => void) => {
      try {
        fn();
      } catch (err) {
        if (/changed outside Psyche|schema changed/.test(String(err))) aborts++;
        else throw err;
      }
    };
    for (let round = 0; round < 60; round++) {
      const dev = `dev${round % 8}`;
      act(() => touchLastSeen(d, dev));
      act(() => updateDevice(d, dev, { name: `device ${round}` }));
      act(() => setSetting(d, "_gateway.stateVersion", round));
      act(() => setSetting(d, "permissions.policy", { round }));
      act(() => approval(`ap${round}`));
      act(() =>
        d.sqlite
          .prepare(
            "UPDATE approvals SET status = 'approved', decided_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(now(), now(), `ap${round}`),
      );
      act(() => grant(`g${round}`, `ap${round}`));
      act(() =>
        d.sqlite.transaction(() => {
          for (let k = 0; k < 3; k++) {
            d.sqlite
              .prepare(
                "UPDATE grants SET use_count = use_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?",
              )
              .run(now(), now(), `g${round}`);
          }
        })(),
      );
      // Approval expiry, in bulk.
      act(() =>
        d.sqlite
          .prepare(
            "UPDATE approvals SET status = 'expired', updated_at = ? WHERE status = 'pending'",
          )
          .run(now()),
      );
      if (round % 10 === 0 && round < 30) {
        act(() =>
          d.sqlite
            .prepare(
              `INSERT INTO passkeys (id, device_id, credential_id, public_key, name, created_at)
               VALUES (?, ?, ?, x'01', 'k', ?)`,
            )
            .run(`pk${round}`, "dev7", `cred${round}`, now()),
        );
      }
      if (round === 30) act(() => d.sqlite.prepare("DELETE FROM devices WHERE id = 'dev7'").run());
      if (round === 40) act(() => revokeDevice(d, "dev6"));
      if (round % 7 === 0) act(() => seal.alerts.add("recovery_applied", { op: "presence.reset" }));
      if (round % 5 === 0) {
        // Another program's unrelated commits: each one makes the Gateway run a full check.
        foreign((f) => setSetting(f, "appearance.theme", `t${round}`));
        foreign((f) =>
          f.sqlite
            .prepare(
              "INSERT INTO security_requests (id, op, params, created_at, updated_at) VALUES (?, 'noop', '{}', ?, ?)",
            )
            .run(`req${round}`, f.now(), f.now()),
        );
      }
      seal.ensure();
    }
    for (const a of seal.alerts.open()) seal.alerts.acknowledge(a.id, null);
    seal.prune();
    seal.ensure();
    expect(aborts).toBe(0);
    expect(seal.status().status).toBe("sealed");
    expect(seal.alerts.list().filter((a) => a.kind === "state_changed_outside")).toEqual([]);
    expect(seal.driftCount()).toBe(0);
    const { seal: again } = await restart();
    expect(again.status().status).toBe("sealed");
    expect(again.alerts.open()).toEqual([]);
  });
});

describe("D10: pruning the sealed set", () => {
  it("old decided approvals, spent grants and acknowledged alerts leave it; the seal stays valid", async () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const d = openDb(dbPath, { now: () => clock.toISOString() });
    open.push(d);
    const seal = await StateSeal.open(d, { home, now: () => clock });
    d.sqlite
      .prepare(
        `INSERT INTO approvals (id, kind, summary, details, binding_hash, grant_key, device_only, requires_authentication,
           taint, surfaces, scopes_offered, answer_tokens, status, request_input, boot_id, requested_at, expires_at,
           decided_at, created_at, updated_at)
         VALUES ('old', 'site', 's', '{}', 'b', 'k', 0, 0, 0, '[]', '[]', '[]', 'denied', '{}', 'boot', ?, ?, ?, ?, ?)`,
      )
      .run(...Array(5).fill(clock.toISOString()));
    d.sqlite
      .prepare(
        `INSERT INTO grants (id, kind, scope, grant_key, subject, side_effect, created_at, updated_at, revoked_at)
         VALUES ('spent', 'site', 'always', 'k', '{}', 'read', ?, ?, ?)`,
      )
      .run(...Array(3).fill(clock.toISOString()));
    const alert = seal.alerts.add("recovery_applied", {});
    seal.alerts.acknowledge(alert.id, null);
    clock = new Date("2027-03-01T00:00:00.000Z");
    expect(seal.prune()).toMatchObject({ approvals: 1, grants: 1, alerts: 1 });
    seal.ensure();
    expect(seal.status().status).toBe("sealed");
    const { seal: again } = await restart();
    expect(again.status().status).toBe("sealed");
  });
});

describe("concern 5: boot never throws", () => {
  it("an unwritable security folder gives an in-memory key and an untrusted state", async () => {
    // `security` is a file, not a folder: nothing can be read or written there.
    writeFileSync(join(home, "security"), "not a folder");
    const seal = await StateSeal.open(db(), { home });
    expect(seal.status()).toEqual({ status: "untrusted", reason: "key_unwritable" });
  });
});
