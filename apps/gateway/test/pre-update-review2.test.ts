import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MigrationError, openDb, probeMigrations } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireGatewayLock,
  clearInterruptedRestore,
  clearUpdateFailure,
  createSnapshot,
  finishPendingRestore,
  listSnapshots,
  openDbWithSnapshot,
  preUpdateDir,
  pruneSnapshots,
  RESTORE_MARKER_FILE,
  readUpdateFailure,
  restoreWithMarker,
  UPDATE_FAILED_FILE,
} from "../src/pre-update.ts";

/**
 * Round-2 review of the pre-update snapshot: a snapshot is put back over live data only with
 * positive evidence, never while the data cannot be read, and what a restore replaces is kept.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const M1 = "202601010000_test_one.sql";
const M2 = "202601020000_test_two.sql";
const M3 = "202601030000_test_three.sql";
const BAD = "SELECT * FROM table_that_is_not_there;";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "psy-r2-"));
  roots.push(root);
  const home = join(root, "home");
  const migrations = join(root, "migrations");
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(migrations);
  const put = (all: Record<string, string>) => {
    for (const [name, sql] of Object.entries(all)) writeFileSync(join(migrations, name), sql);
  };
  put({ [M1]: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);" });
  const dbPath = join(home, "state", "psyche.sqlite");
  const db = openDb(dbPath, { migrationsDir: migrations });
  db.sqlite.prepare("INSERT INTO notes (body) VALUES ('keep me')").run();
  db.close();
  return { root, home, migrations, put, dbPath };
}
type S = ReturnType<typeof setup>;

const at = (n: number) => () => new Date(Date.UTC(2026, 10, 5, 12, n, 0));
const base = (s: S, over: Record<string, unknown> = {}) => ({
  home: s.home,
  dbPath: s.dbPath,
  version: "0.5.0",
  build: "build-b",
  now: at(0),
  open: { migrationsDir: s.migrations },
  ...over,
});
const bodies = (path: string) => {
  const d = new DatabaseSync(path, { readOnly: true });
  try {
    return (d.prepare("SELECT body FROM notes ORDER BY id").all() as { body: string }[]).map(
      (r) => r.body,
    );
  } finally {
    d.close();
  }
};
const addNote = (path: string, body: string) => {
  const d = new DatabaseSync(path);
  d.prepare("INSERT INTO notes (body) VALUES (?)").run(body);
  d.close();
};
const displaced = (s: S) =>
  existsSync(preUpdateDir(s.home))
    ? readdirSync(preUpdateDir(s.home)).filter((n) => n.startsWith(".displaced-"))
    : [];

describe("reuse needs evidence (H1)", () => {
  it("A: an older version ran for a week after the failure; Retry does not wipe the week", async () => {
    const s = setup();
    s.put({ [M2]: BAD });
    await expect(openDbWithSnapshot(base(s))).rejects.toThrow(/put everything back/);
    // The pre-feature version A ran on the restored data for a week. It never writes
    // last-boot.json, and it added notes.
    addNote(s.dbPath, "a week of notes");
    rmSync(join(s.home, "state", "last-boot.json"), { force: true });
    // B is installed again and the owner presses Retry.
    clearUpdateFailure(s.home);
    await expect(openDbWithSnapshot(base(s, { now: at(60) }))).rejects.toThrow(
      /put everything back/,
    );
    // The second failure was undone from a snapshot taken NOW, so the week is still there.
    expect(bodies(s.dbPath)).toEqual(["keep me", "a week of notes"]);
    expect(listSnapshots(s.home)).toHaveLength(2);
  });

  it("B: a backup restored over state/ is not overwritten by an old snapshot", async () => {
    const s = setup();
    writeFileSync(join(s.home, "config.json"), '{"gateway":{"port":7000}}');
    s.put({ [M2]: BAD });
    await expect(openDbWithSnapshot(base(s))).rejects.toThrow();
    // `backup restore --force` from a backup made under A: older data, its own config, and a
    // state/ without B's last-boot.json.
    addNote(s.dbPath, "from the backup");
    writeFileSync(join(s.home, "config.json"), '{"gateway":{"port":7100}}');
    rmSync(join(s.home, "state", "last-boot.json"), { force: true });
    clearUpdateFailure(s.home);
    await expect(openDbWithSnapshot(base(s, { now: at(5) }))).rejects.toThrow();
    // Config and data are the backup's, not a mix with the old snapshot's.
    expect(bodies(s.dbPath)).toEqual(["keep me", "from the backup"]);
    expect(readFileSync(join(s.home, "config.json"), "utf8")).toBe('{"gateway":{"port":7100}}');
  });

  it("C: never restores while the data cannot be read, even with last-boot.json gone", async () => {
    const s = setup();
    s.put({ [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;", [M3]: BAD });
    // A snapshot of readable data for this very build exists...
    await createSnapshot({
      home: s.home,
      dbPath: s.dbPath,
      from: "a",
      to: "0.5.0",
      build: "build-b",
      pending: [M2.slice(0, -4), M3.slice(0, -4)],
      now: at(0),
    });
    rmSync(join(s.home, "state", "last-boot.json"), { force: true });
    // ...and now the database is busy/unreadable (here: not a database at all).
    writeFileSync(s.dbPath, "being repaired by hand");
    await expect(openDbWithSnapshot(base(s, { now: at(3) }))).rejects.toThrow();
    expect(readFileSync(s.dbPath, "utf8")).toBe("being repaired by hand");
    expect(displaced(s)).toEqual([]);
    // It took its own snapshot of what is there, marked as unreadable.
    expect(listSnapshots(s.home)[0]?.manifest.probe).toBeDefined();
  });

  it("restores after a cut-short start, and keeps what it replaced", async () => {
    const s = setup();
    s.put({
      [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;",
      [M3]: "CREATE TABLE extra (id INTEGER);",
    });
    const half = join(s.root, "half");
    mkdirSync(half);
    writeFileSync(join(half, M1), readFileSync(join(s.migrations, M1)));
    writeFileSync(join(half, M2), readFileSync(join(s.migrations, M2)));
    writeFileSync(join(s.home, "config.json"), '{"before":1}');
    const crashing = (path: string) => {
      const d = openDb(path, { migrationsDir: half });
      d.sqlite.prepare("DELETE FROM notes").run();
      d.close();
      // The owner (or the app) changed the config between the two starts.
      writeFileSync(join(s.home, "config.json"), '{"changed":2}');
      throw new Error("killed");
    };
    await expect(openDbWithSnapshot(base(s, { opener: crashing }))).rejects.toThrow("killed");
    (await openDbWithSnapshot(base(s, { now: at(5) }))).close();
    expect(bodies(s.dbPath)).toEqual(["keep me"]);
    // Only the databases were put back (M2 of M2): the config is the owner's latest.
    expect(readFileSync(join(s.home, "config.json"), "utf8")).toBe('{"changed":2}');
    // The half-migrated database that was replaced was moved aside, not deleted.
    const [dir] = displaced(s);
    expect(dir).toBeDefined();
    expect(existsSync(join(preUpdateDir(s.home), dir ?? "", "state", "psyche.sqlite"))).toBe(true);
  });

  it("falls back to a fresh snapshot when the old one is damaged, without blaming the disk", async () => {
    const s = setup();
    s.put({
      [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;",
      [M3]: "CREATE TABLE extra (id INTEGER);",
    });
    const half = join(s.root, "half");
    mkdirSync(half);
    writeFileSync(join(half, M1), readFileSync(join(s.migrations, M1)));
    writeFileSync(join(half, M2), readFileSync(join(s.migrations, M2)));
    const crashing = (path: string) => {
      openDb(path, { migrationsDir: half }).close();
      throw new Error("killed");
    };
    await expect(openDbWithSnapshot(base(s, { opener: crashing }))).rejects.toThrow("killed");
    const first = listSnapshots(s.home)[0];
    writeFileSync(join(first?.dir ?? "", "files", "state", "psyche.sqlite"), "damaged");
    (await openDbWithSnapshot(base(s, { now: at(5) }))).close();
    expect(readUpdateFailure(s.home)).toBeUndefined();
    expect(listSnapshots(s.home)).toHaveLength(2);
  });
});

describe("an unreadable snapshot is never a rollback point (H2)", () => {
  it("a repair made after it survives a failed migration", async () => {
    const s = setup();
    s.put({ [M2]: BAD });
    writeFileSync(s.dbPath, "corrupt: this is not a database");
    await expect(openDbWithSnapshot(base(s))).rejects.toThrow();
    const unreadable = listSnapshots(s.home)[0];
    expect(unreadable?.manifest.probe).toBeDefined();
    // The owner repairs the database by hand (here: a good one, with their note in it).
    rmSync(s.dbPath, { force: true });
    const v1 = join(s.root, "v1");
    mkdirSync(v1);
    writeFileSync(join(v1, M1), readFileSync(join(s.migrations, M1)));
    const fixed = openDb(s.dbPath, { migrationsDir: v1 });
    fixed.sqlite.prepare("INSERT INTO notes (body) VALUES ('repaired')").run();
    fixed.close();
    await expect(openDbWithSnapshot(base(s, { now: at(3) }))).rejects.toThrow(
      /put everything back/,
    );
    expect(bodies(s.dbPath)).toEqual(["repaired"]);
    // The fresh snapshot, not the corrupt one, was the rollback point.
    expect(listSnapshots(s.home)).toHaveLength(2);
    expect(listSnapshots(s.home)[0]?.manifest.probe).toBeUndefined();
  });

  it("if the data reads by the time it migrates and that fails, the corrupt copy is not put back", async () => {
    const s = setup();
    s.put({ [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;" });
    writeFileSync(s.dbPath, "corrupt: this is not a database");
    // The probe sees garbage; by the time the opener runs the file reads (a repair, a lock
    // released) and its migration fails.
    const opener = () => {
      rmSync(s.dbPath, { force: true });
      const fixed = openDb(s.dbPath, { migrationsDir: s.migrations });
      fixed.sqlite.prepare("INSERT INTO notes (body) VALUES ('readable now')").run();
      fixed.close();
      throw new MigrationError('migration "x.sql" failed: boom', "x");
    };
    await expect(openDbWithSnapshot(base(s, { opener }))).rejects.toThrow(
      /could not be read when the update began/,
    );
    expect(bodies(s.dbPath)).toEqual(["readable now"]);
    expect(readUpdateFailure(s.home)).toMatchObject({ restored: false });
  });
});

describe("one Gateway per data folder (M3)", () => {
  it("refuses to start while another live process holds the lock, and takes over a dead one's", () => {
    const s = setup();
    mkdirSync(join(s.home, "run"), { recursive: true });
    const lock = join(s.home, "run", "gateway.lock");
    // The parent process is alive and is not us.
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: "x" }));
    expect(() => acquireGatewayLock(s.home)).toThrow(/already using this data folder/);
    // A pid nobody has.
    writeFileSync(lock, JSON.stringify({ pid: 2_147_483_000, at: "x" }));
    expect(() => acquireGatewayLock(s.home)).not.toThrow();
    expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);
    // And us again is fine.
    expect(() => acquireGatewayLock(s.home)).not.toThrow();
  });

  it("is taken before anything is restored or copied", async () => {
    const s = setup();
    mkdirSync(join(s.home, "run"), { recursive: true });
    writeFileSync(join(s.home, "run", "gateway.lock"), JSON.stringify({ pid: process.ppid }));
    s.put({ [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;" });
    await expect(openDbWithSnapshot(base(s))).rejects.toMatchObject({
      details: { reason: "gateway_running" },
    });
    expect(existsSync(preUpdateDir(s.home))).toBe(false);
  });
});

describe("an interrupted restore (M4 and lows)", () => {
  async function interrupted(s: S) {
    const dir = await createSnapshot({
      home: s.home,
      dbPath: s.dbPath,
      from: "a",
      to: "0.5.0",
      build: "build-b",
      pending: [],
      now: at(0),
    });
    mkdirSync(join(s.home, "run"), { recursive: true });
    return dir;
  }

  it("tells the start-up screen why it cannot start, and can be cleared by hand", async () => {
    const s = setup();
    await interrupted(s);
    writeFileSync(
      join(s.home, RESTORE_MARKER_FILE),
      JSON.stringify({ snapshot: join(preUpdateDir(s.home), "gone"), at: "x" }),
    );
    await expect(openDbWithSnapshot(base(s))).rejects.toMatchObject({
      details: { reason: "restore_interrupted" },
    });
    const note = readUpdateFailure(s.home);
    expect(note).toMatchObject({ key: "restore-interrupted", build: "build-b", restored: false });
    expect(note?.message).toContain("restored-by-hand");
    // "I restored it myself".
    expect(clearInterruptedRestore(s.home)).toBe(true);
    expect(existsSync(join(s.home, RESTORE_MARKER_FILE))).toBe(false);
    expect(readUpdateFailure(s.home)).toBeUndefined();
    (await openDbWithSnapshot(base(s))).close();
  });

  it("fails closed on a damaged note, and on one pointing outside the snapshots", async () => {
    const s = setup();
    const dir = await interrupted(s);
    writeFileSync(join(s.home, RESTORE_MARKER_FILE), "{not json");
    expect(() => finishPendingRestore(s.home)).toThrow(/damaged/);
    writeFileSync(
      join(s.home, RESTORE_MARKER_FILE),
      JSON.stringify({ snapshot: join(s.root, "elsewhere"), at: "x" }),
    );
    expect(() => finishPendingRestore(s.home)).toThrow(/outside the snapshots/);
    // No note at all is simply "nothing to finish".
    rmSync(join(s.home, RESTORE_MARKER_FILE));
    expect(finishPendingRestore(s.home)).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it("takes the allowed absolute path from the caller, never from the note", async () => {
    const s = setup();
    const outside = join(s.root, "elsewhere.sqlite");
    const db = openDb(outside, { migrationsDir: s.migrations });
    db.close();
    const dir = await createSnapshot({
      home: s.home,
      dbPath: outside,
      from: "a",
      to: "b",
      pending: [],
      now: at(0),
    });
    mkdirSync(join(s.home, "run"), { recursive: true });
    writeFileSync(
      join(s.home, RESTORE_MARKER_FILE),
      JSON.stringify({ snapshot: dir, at: "x", allowAbsolute: [outside] }),
    );
    expect(() => finishPendingRestore(s.home)).toThrow();
    expect(finishPendingRestore(s.home, { allowAbsolute: [outside] })).toBe(true);
  });

  it("after finishing, a 'could not put it back' note says it was put back", async () => {
    const s = setup();
    const dir = await interrupted(s);
    writeFileSync(
      join(s.home, UPDATE_FAILED_FILE),
      JSON.stringify({
        build: "build-b",
        key: "build-b",
        kind: "deterministic",
        attempts: 1,
        retryAfter: null,
        from: "a",
        to: "0.5.0",
        migration: "x",
        at: "x",
        snapshot: dir,
        restored: false,
        message: "could not put it back automatically",
      }),
    );
    writeFileSync(join(s.home, RESTORE_MARKER_FILE), JSON.stringify({ snapshot: dir, at: "x" }));
    expect(finishPendingRestore(s.home)).toBe(true);
    const note = readUpdateFailure(s.home);
    expect(note?.restored).toBe(true);
    expect(note?.message).toContain("put everything back");
  });

  it("restoring moves the replaced files aside instead of overwriting them", async () => {
    const s = setup();
    const dir = await interrupted(s);
    addNote(s.dbPath, "written after the snapshot");
    restoreWithMarker(dir, s.home, { now: at(1) });
    expect(bodies(s.dbPath)).toEqual(["keep me"]);
    const [aside] = displaced(s);
    expect(bodies(join(preUpdateDir(s.home), aside ?? "", "state", "psyche.sqlite"))).toEqual([
      "keep me",
      "written after the snapshot",
    ]);
  });
});

describe("housekeeping lows", () => {
  it("never counts an unreadable date as old, and clamps one in the future", async () => {
    const s = setup();
    for (let i = 0; i < 3; i++)
      await createSnapshot({
        home: s.home,
        dbPath: s.dbPath,
        from: "a",
        to: "b",
        pending: [],
        now: at(i),
      });
    const [, second, third] = listSnapshots(s.home);
    const rewrite = (dir: string | undefined, createdAt: string) => {
      const m = JSON.parse(readFileSync(join(dir ?? "", "manifest.json"), "utf8"));
      m.createdAt = createdAt;
      writeFileSync(join(dir ?? "", "manifest.json"), JSON.stringify(m));
    };
    rewrite(second?.dir, "not a date");
    rewrite(third?.dir, "2999-01-01T00:00:00.000Z");
    const later = new Date(Date.UTC(2027, 0, 1));
    expect(pruneSnapshots(s.home, { keep: 1, now: later })).toEqual([]);
  });

  it("clears displaced files after the same 14 days as snapshots, not before", async () => {
    const s = setup();
    const dir = await createSnapshot({
      home: s.home,
      dbPath: s.dbPath,
      from: "a",
      to: "b",
      pending: [],
      now: at(0),
    });
    restoreWithMarker(dir, s.home, { now: at(1) });
    const [aside] = displaced(s);
    expect(pruneSnapshots(s.home, { keep: 5 })).toEqual([]);
    expect(displaced(s)).toHaveLength(1);
    const old = new Date(Date.now() - 20 * 24 * 3_600_000);
    utimesSync(join(preUpdateDir(s.home), aside ?? ""), old, old);
    pruneSnapshots(s.home, { keep: 5 });
    expect(displaced(s)).toEqual([]);
  });

  it("probes read-only: reading the version of a database never writes to it", () => {
    const s = setup();
    const before = readFileSync(s.dbPath);
    s.put({ [M2]: "CREATE TABLE z (id INTEGER);" });
    expect(probeMigrations(s.dbPath, s.migrations)).toMatchObject({ state: "pending" });
    expect(readFileSync(s.dbPath).equals(before)).toBe(true);
  });
});
