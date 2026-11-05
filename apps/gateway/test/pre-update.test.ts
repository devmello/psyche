import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MigrationError, openDb } from "@psyche/db";
import { isOwnerOnly } from "@psyche/hostfs";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSnapshot,
  DEFAULT_KEEP,
  findDatabases,
  keepFromEnv,
  listSnapshots,
  openDbWithSnapshot,
  pruneSnapshots,
  readUpdateFailure,
  releaseAllGatewayLocks,
  restoreSnapshot,
  UPDATE_FAILED_FILE,
} from "../src/pre-update.ts";

/**
 * The snapshot in front of pending migrations (updates design §2.7). Everything runs in
 * temporary directories with small migration folders of their own; no real $PSYCHE_HOME.
 */

const roots: string[] = [];
afterEach(() => {
  releaseAllGatewayLocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const M1 = "202601010000_test_one.sql";
const M2 = "202601020000_test_two.sql";
const M3 = "202601030000_test_three.sql";

function setup(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "psy-pre-"));
  roots.push(root);
  const home = join(root, "home");
  const migrations = join(root, "migrations");
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(migrations);
  const put = (all: Record<string, string>) => {
    for (const [name, sql] of Object.entries(all)) writeFileSync(join(migrations, name), sql);
  };
  put({ [M1]: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);", ...files });
  return { root, home, migrations, put, dbPath: join(home, "state", "psyche.sqlite") };
}

const at = (n: number) => () => new Date(Date.UTC(2026, 10, 5, 12, n, 0));

function rows(path: string, sql: string): unknown[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all() as unknown[];
  } finally {
    db.close();
  }
}

const tables = (path: string) =>
  (
    rows(path, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name") as {
      name: string;
    }[]
  )
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_"));

/** An installed Gateway at migration one with a note in it, then closed. */
function installV1(s: ReturnType<typeof setup>) {
  const db = openDb(s.dbPath, { migrationsDir: s.migrations });
  db.sqlite.prepare("INSERT INTO notes (body) VALUES ('keep me')").run();
  db.close();
}

const base = (s: ReturnType<typeof setup>, over: Record<string, unknown> = {}) => ({
  home: s.home,
  dbPath: s.dbPath,
  version: "0.5.0",
  build: "build-b",
  now: at(0),
  open: { migrationsDir: s.migrations },
  ...over,
});

describe("openDbWithSnapshot", () => {
  it("makes no snapshot on a new install or when nothing is pending", async () => {
    const s = setup();
    const db = await openDbWithSnapshot(base(s));
    db.close();
    expect(existsSync(join(s.home, "backups"))).toBe(false);
    // Up to date: still none.
    (await openDbWithSnapshot(base(s))).close();
    expect(existsSync(join(s.home, "backups"))).toBe(false);
    // It does remember which version last opened the data (the next snapshot's name).
    expect(JSON.parse(readFileSync(join(s.home, "state", "last-boot.json"), "utf8"))).toMatchObject(
      { version: "0.5.0", build: "build-b" },
    );
  });

  it("snapshots every database and config.json before applying pending migrations", async () => {
    const s = setup();
    installV1(s);
    writeFileSync(join(s.home, "config.json"), '{"gateway":{"port":8123}}');
    // A database that is not plain SQLite (the memory store is encrypted), the vault, an index,
    // and things that must not be copied.
    writeFileSync(
      join(s.home, "state", "memory.sqlite"),
      Buffer.from("not sqlite, encrypted bytes"),
    );
    writeFileSync(join(s.home, "state", "memory.sqlite-wal"), Buffer.from("wal bytes"));
    writeFileSync(join(s.home, "state", "memory.sqlite-shm"), Buffer.from("shm bytes"));
    writeFileSync(join(s.home, "state", "memory.key.json"), "{}");
    mkdirSync(join(s.home, "vault"));
    writeFileSync(join(s.home, "vault", "vault.db"), Buffer.from("vault bytes"));
    writeFileSync(join(s.home, "vault", "slots.json"), '{"slots":{}}');
    mkdirSync(join(s.home, "state", "teach"));
    writeFileSync(join(s.home, "state", "teach", "recording.db"), "owner recording");
    mkdirSync(join(s.home, "workspace"));
    writeFileSync(join(s.home, "workspace", "big.db"), "workspace file");
    s.put({ [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;" });

    // Read in this run before the migration, then written to by another connection: the online
    // backup copies the committed state even while the file is in WAL mode and open elsewhere.
    const held = new DatabaseSync(s.dbPath);
    held.exec("PRAGMA journal_mode = WAL");
    held.prepare("INSERT INTO notes (body) VALUES ('still in the WAL')").run();

    const db = await openDbWithSnapshot(base(s, { now: at(1) }));
    held.close();
    db.close();
    expect(tables(s.dbPath)).toContain("notes");
    expect(
      (rows(s.dbPath, "PRAGMA table_info(notes)") as { name: string }[]).map((c) => c.name),
    ).toContain("tag");

    const [snap] = listSnapshots(s.home);
    expect(snap?.dir).toMatch(
      /backups(?:\/|\\)pre-update(?:\/|\\)unknown-to-0\.5\.0-2026-11-05T12-01-00-000Z$/,
    );
    const m = snap?.manifest;
    expect(m).toMatchObject({
      from: "unknown",
      to: "0.5.0",
      build: "build-b",
      pending: [M2.slice(0, -4)],
    });
    expect(m?.entries.map((e) => [e.rel, e.kind]).sort()).toEqual([
      ["config.json", "file"],
      ["state/memory.key.json", "file"],
      ["state/memory.sqlite", "file"],
      ["state/psyche.sqlite", "sqlite"],
      ["vault/slots.json", "file"],
      ["vault/vault.db", "file"],
    ]);
    // The encrypted store's log is checksummed and private; the rebuildable index is not copied.
    const memory = m?.entries.find((e) => e.rel === "state/memory.sqlite");
    expect(memory?.sidecars?.map((x) => x.suffix)).toEqual(["-wal"]);
    expect(isOwnerOnly(join(snap?.dir ?? "", "files", "state", "memory.sqlite-wal"))).toBe(true);
    expect(existsSync(join(snap?.dir ?? "", "files", "state", "memory.sqlite-shm"))).toBe(false);
    // The key files that open the stores travel with them.
    expect(readFileSync(join(snap?.dir ?? "", "files", "vault", "slots.json"), "utf8")).toBe(
      '{"slots":{}}',
    );
    const copy = join(snap?.dir ?? "", "files", "state", "psyche.sqlite");
    // The copy is the data before the migration, including what was only in the WAL.
    expect(rows(copy, "SELECT body FROM notes ORDER BY id")).toEqual([
      { body: "keep me" },
      { body: "still in the WAL" },
    ]);
    expect(
      (rows(copy, "PRAGMA table_info(notes)") as { name: string }[]).map((c) => c.name),
    ).not.toContain("tag");
    expect(readFileSync(join(snap?.dir ?? "", "files", "config.json"), "utf8")).toBe(
      '{"gateway":{"port":8123}}',
    );
    expect(readFileSync(join(snap?.dir ?? "", "files", "state", "memory.sqlite"), "utf8")).toBe(
      "not sqlite, encrypted bytes",
    );
    expect(readFileSync(join(snap?.dir ?? "", "files", "state", "memory.sqlite-wal"), "utf8")).toBe(
      "wal bytes",
    );
    expect(existsSync(join(snap?.dir ?? "", "files", "state", "teach"))).toBe(false);
    expect(existsSync(join(snap?.dir ?? "", "files", "workspace"))).toBe(false);
    // Private: 0700 folders, 0600 files.
    expect(isOwnerOnly(snap?.dir ?? "")).toBe(true);
    expect(isOwnerOnly(join(snap?.dir ?? "", "files"))).toBe(true);
    expect(isOwnerOnly(copy)).toBe(true);
    expect(isOwnerOnly(join(snap?.dir ?? "", "manifest.json"))).toBe(true);
    expect(isOwnerOnly(join(s.home, "backups", "pre-update"))).toBe(true);
  });

  it("names the snapshot after the version that last opened the data", async () => {
    const s = setup();
    installV1(s);
    (await openDbWithSnapshot(base(s, { version: "0.4.2", build: "build-a" }))).close();
    s.put({ [M2]: "CREATE TABLE extra (id INTEGER);" });
    (await openDbWithSnapshot(base(s, { now: at(2) }))).close();
    expect(listSnapshots(s.home)[0]?.manifest).toMatchObject({ from: "0.4.2", to: "0.5.0" });
  });

  it("puts the snapshot back when a migration fails, refuses to start, and says so plainly", async () => {
    const s = setup();
    installV1(s);
    writeFileSync(join(s.home, "config.json"), '{"gateway":{"port":8123}}');
    // Two pending: the first applies, the second fails. Both must be undone.
    s.put({
      [M2]: "CREATE TABLE half_done (id INTEGER); INSERT INTO notes (body) VALUES ('from m2');",
      [M3]: "CREATE TABLE broken (id INTEGER); SELECT * FROM table_that_is_not_there;",
    });
    const warn: string[] = [];
    const err = await openDbWithSnapshot(
      base(s, { now: at(3), logger: { log: (_l: string, msg: string) => warn.push(msg) } }),
    ).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
    );
    expect(err?.code).toBe("unavailable");
    expect(err?.message).toContain("put everything back the way it was");
    expect(err?.message).toContain("Nothing was lost");
    expect(err?.message).not.toMatch(/SQLITE|table_that_is_not_there|\.sql/);
    expect(err?.details).toMatchObject({
      reason: "update_failed",
      migration: M3.slice(0, -4),
      restored: true,
    });
    // Data is exactly as it was: no half-applied migration, the note, the config.
    expect(tables(s.dbPath)).toEqual(["_migrations", "notes"]);
    expect(rows(s.dbPath, "SELECT body FROM notes")).toEqual([{ body: "keep me" }]);
    expect(rows(s.dbPath, "SELECT id FROM _migrations")).toEqual([{ id: M1.slice(0, -4) }]);
    expect(readFileSync(join(s.home, "config.json"), "utf8")).toBe('{"gateway":{"port":8123}}');
    expect(existsSync(`${s.dbPath}-wal`) ? statSync(`${s.dbPath}-wal`).size : 0).toBe(0);
    expect(warn).toContain("migration failed; data restored");
    expect(readUpdateFailure(s.home)).toMatchObject({
      build: "build-b",
      to: "0.5.0",
      migration: M3.slice(0, -4),
    });
    expect(isOwnerOnly(join(s.home, UPDATE_FAILED_FILE))).toBe(true);
  });

  it("does not try again on every restart with the same build, but does with a newer one", async () => {
    const s = setup();
    installV1(s);
    s.put({ [M2]: "SELECT * FROM table_that_is_not_there;" });
    await expect(openDbWithSnapshot(base(s, { now: at(4) }))).rejects.toThrow(
      /put everything back/,
    );
    expect(listSnapshots(s.home)).toHaveLength(1);
    // launchd restarts the Gateway: same build, same failure. No new snapshot, no new attempt.
    await expect(openDbWithSnapshot(base(s, { now: at(5) }))).rejects.toThrow(
      /put everything back/,
    );
    expect(listSnapshots(s.home)).toHaveLength(1);
    // The fixed release (a different build) tries again, and a success clears the marker.
    s.put({ [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;" });
    const db = await openDbWithSnapshot(
      base(s, { now: at(6), build: "build-c", version: "0.5.1" }),
    );
    db.close();
    expect(readUpdateFailure(s.home)).toBeUndefined();
    expect(
      (rows(s.dbPath, "PRAGMA table_info(notes)") as { name: string }[]).map((c) => c.name),
    ).toContain("tag");
    expect(rows(s.dbPath, "SELECT body FROM notes")).toEqual([{ body: "keep me" }]);
  });

  it("restores even a database the failing migration had already changed on disk", async () => {
    const s = setup();
    installV1(s);
    writeFileSync(join(s.home, "config.json"), '{"a":1}');
    const opener = (path: string) => {
      // A migration that wrote, then something went wrong: the live files are not what they were.
      const db = openDb(path, { migrate: false, migrationsDir: s.migrations });
      db.sqlite.prepare("DELETE FROM notes").run();
      db.close();
      writeFileSync(join(s.home, "config.json"), "{}");
      throw new MigrationError('migration "x.sql" failed: boom', "x");
    };
    s.put({ [M2]: "CREATE TABLE extra (id INTEGER);" });
    await expect(openDbWithSnapshot(base(s, { opener }))).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(rows(s.dbPath, "SELECT body FROM notes")).toEqual([{ body: "keep me" }]);
    expect(readFileSync(join(s.home, "config.json"), "utf8")).toBe('{"a":1}');
  });

  it("leaves the data alone when the database was only locked by another process", async () => {
    const s = setup();
    installV1(s);
    s.put({ [M2]: "CREATE TABLE extra (id INTEGER);" });
    const opener = () => {
      throw new MigrationError('migration "x.sql" failed: database is locked', "x");
    };
    await expect(openDbWithSnapshot(base(s, { opener }))).rejects.toBeInstanceOf(MigrationError);
    expect(readUpdateFailure(s.home)).toBeUndefined();
  });

  it("refuses to migrate when it cannot make the safety copy, and changes nothing", async () => {
    const s = setup();
    installV1(s);
    s.put({ [M2]: "CREATE TABLE extra (id INTEGER);" });
    // `backups` is a file, so no snapshot folder can exist (a stand-in for a full disk).
    writeFileSync(join(s.home, "backups"), "in the way");
    await expect(openDbWithSnapshot(base(s))).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("couldn't make a safety copy"),
    });
    expect(tables(s.dbPath)).toEqual(["_migrations", "notes"]);
  });

  it("keeps the newest snapshots only", async () => {
    const s = setup();
    installV1(s);
    for (let i = 0; i < 5; i++) {
      s.put({ [`2026020${i + 1}0000_test_step${i}.sql`]: `CREATE TABLE t${i} (id INTEGER);` });
      (await openDbWithSnapshot(base(s, { now: at(10 + i), keep: 3, minPruneAgeMs: 0 }))).close();
    }
    const kept = listSnapshots(s.home);
    expect(kept).toHaveLength(3);
    expect(kept.map((k) => k.manifest.seq)).toEqual([5, 4, 3]);
    expect(readdirSync(join(s.home, "backups", "pre-update"))).toHaveLength(3);
  });
});

describe("snapshot helpers", () => {
  it("prunes half-made folders and never below one snapshot", async () => {
    const s = setup();
    installV1(s);
    for (let i = 0; i < 3; i++)
      await createSnapshot({
        home: s.home,
        dbPath: s.dbPath,
        from: "a",
        to: "b",
        pending: [],
        now: at(i),
      });
    mkdirSync(join(s.home, "backups", "pre-update", ".partial-crashed"));
    expect(pruneSnapshots(s.home, { keep: 0, minAgeMs: 0 })).toHaveLength(2);
    expect(listSnapshots(s.home)).toHaveLength(1);
    expect(existsSync(join(s.home, "backups", "pre-update", ".partial-crashed"))).toBe(false);
  });

  it("reads PSYCHE_PRE_UPDATE_KEEP, 1 to 20, default 2", () => {
    expect(DEFAULT_KEEP).toBe(2);
    expect(keepFromEnv({})).toBe(2);
    expect(keepFromEnv({ PSYCHE_PRE_UPDATE_KEEP: "5" })).toBe(5);
    for (const bad of ["0", "21", "x", "2.5", ""])
      expect(keepFromEnv({ PSYCHE_PRE_UPDATE_KEEP: bad })).toBe(2);
  });

  it("finds databases under state/ and vault/ but not sidecars or recordings", () => {
    const s = setup();
    for (const f of [
      "state/a.sqlite",
      "state/a.sqlite-wal",
      "state/channels/c.db",
      "state/teach/x.db",
      "state/notes.txt",
      "vault/vault.db",
    ]) {
      mkdirSync(join(s.home, f, ".."), { recursive: true });
      writeFileSync(join(s.home, f), "x");
    }
    expect(findDatabases(s.home)).toEqual([
      "state/a.sqlite",
      "state/channels/c.db",
      "vault/vault.db",
    ]);
  });

  it("will not restore a damaged copy, or write outside the home", async () => {
    const s = setup();
    installV1(s);
    const dir = await createSnapshot({
      home: s.home,
      dbPath: s.dbPath,
      from: "a",
      to: "b",
      pending: [],
      now: at(0),
    });
    const live = readFileSync(s.dbPath);
    writeFileSync(join(dir, "files", "state", "psyche.sqlite"), "damaged");
    expect(() => restoreSnapshot(dir, s.home)).toThrow(/damaged/);
    expect(readFileSync(s.dbPath).equals(live)).toBe(true);

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    manifest.entries[0].rel = "../escape.db";
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    expect(() => restoreSnapshot(dir, s.home)).toThrow(/outside/);
    expect(existsSync(join(s.root, "escape.db"))).toBe(false);
  });

  it("snapshots a database kept outside the home (PSYCHE_DB) and restores it", async () => {
    const s = setup();
    const outside = join(s.root, "elsewhere", "psyche.sqlite");
    mkdirSync(join(s.root, "elsewhere"));
    const db = openDb(outside, { migrationsDir: s.migrations });
    db.sqlite.prepare("INSERT INTO notes (body) VALUES ('outside')").run();
    db.close();
    const dir = await createSnapshot({
      home: s.home,
      dbPath: outside,
      from: "a",
      to: "b",
      pending: [],
      now: at(0),
    });
    const wrecked = new DatabaseSync(outside);
    wrecked.exec("DELETE FROM notes");
    wrecked.close();
    expect(() => restoreSnapshot(dir, s.home)).toThrow(/outside/);
    restoreSnapshot(dir, s.home, { allowAbsolute: [outside] });
    expect(rows(outside, "SELECT body FROM notes")).toEqual([{ body: "outside" }]);
  });
});
