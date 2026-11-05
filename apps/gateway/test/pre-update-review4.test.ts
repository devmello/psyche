import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MigrationError, openDb } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearUpdateFailure,
  createSnapshot,
  listSnapshots,
  openDbWithSnapshot,
  preUpdateDir,
  readUpdateFailure,
  restoreWithMarker,
} from "../src/pre-update.ts";

/** Round-4 review: an empty database is never created over earlier data, and copies stay few. */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const M1 = "202601010000_test_one.sql";
const M2 = "202601020000_test_two.sql";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "psy-r4-"));
  roots.push(root);
  const home = join(root, "home");
  const migrations = join(root, "migrations");
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(migrations);
  writeFileSync(join(migrations, M1), "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);");
  const dbPath = join(home, "state", "psyche.sqlite");
  const db = openDb(dbPath, { migrationsDir: migrations });
  db.sqlite.prepare("INSERT INTO notes (body) VALUES ('keep me')").run();
  db.close();
  return { root, home, migrations, dbPath };
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
const snap = (s: S, n = 0) =>
  createSnapshot({ home: s.home, dbPath: s.dbPath, from: "a", to: "b", pending: [], now: at(n) });
const displacedDirs = (s: S) =>
  readdirSync(preUpdateDir(s.home)).filter((n) => n.startsWith(".displaced-"));

describe("never an empty database over earlier data (M1)", () => {
  async function refused(s: S) {
    const err = await openDbWithSnapshot(base(s)).then(
      () => undefined,
      (e: unknown) => e as { details?: { reason?: string }; message: string },
    );
    expect(err?.details?.reason).toBe("data_missing");
    expect(existsSync(s.dbPath)).toBe(false);
    expect(readUpdateFailure(s.home)).toMatchObject({ key: "data-missing" });
    return err;
  }

  it("refuses when a restore left the database missing and moved the live one aside", async () => {
    const s = setup();
    const dir = await snap(s);
    restoreWithMarker(dir, s.home, { now: at(1) });
    // The disk filled up between moving the live file aside and placing the copy.
    rmSync(s.dbPath);
    expect(displacedDirs(s).length + listSnapshots(s.home).length).toBeGreaterThan(0);
    const err = await refused(s);
    expect(err?.message).toContain("main database is missing");
  });

  it("refuses on a last-boot note, on a snapshot, and on another database being there", async () => {
    const a = setup();
    writeFileSync(join(a.home, "state", "last-boot.json"), '{"version":"0.4.0"}');
    rmSync(a.dbPath);
    await refused(a);

    const b = setup();
    await snap(b);
    rmSync(b.dbPath);
    await refused(b);

    const c = setup();
    writeFileSync(join(c.home, "state", "search.sqlite"), "x".repeat(32));
    rmSync(c.dbPath);
    await refused(c);
  });

  it("still creates the database of a new install, and when the owner has put the old one back", async () => {
    const root = mkdtempSync(join(tmpdir(), "psy-r4-new-"));
    roots.push(root);
    const home = join(root, "home");
    const migrations = join(root, "migrations");
    mkdirSync(migrations);
    writeFileSync(join(migrations, M1), "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);");
    const dbPath = join(home, "state", "psyche.sqlite");
    const fresh = await openDbWithSnapshot({
      home,
      dbPath,
      version: "0.5.0",
      build: "b",
      open: { migrationsDir: migrations },
    });
    fresh.close();
    expect(existsSync(dbPath)).toBe(true);
    // With the database present, history in the folder is no obstacle.
    const again = await openDbWithSnapshot({
      home,
      dbPath,
      version: "0.5.0",
      build: "b",
      open: { migrationsDir: migrations },
    });
    again.close();
  });
});

describe("a restore never leaves a moment with no database (M1)", () => {
  it("stages the copy before moving anything, so a full disk leaves the live file where it is", async () => {
    const s = setup();
    const dir = await snap(s);
    addNote(s.dbPath, "newer");
    // The copy cannot be written beside the target (here: something is in its way).
    mkdirSync(`${s.dbPath}.restoring`);
    expect(() => restoreWithMarker(dir, s.home, { now: at(1) })).toThrow();
    expect(bodies(s.dbPath)).toEqual(["keep me", "newer"]);
    expect(existsSync(join(preUpdateDir(s.home), ".displaced-" + basename(dir)))).toBe(false);
  });
});

describe("a displaced folder never swallows live data (M2)", () => {
  it("is named after the snapshot's own folder", async () => {
    const s = setup();
    const dir = await snap(s);
    addNote(s.dbPath, "x");
    restoreWithMarker(dir, s.home, { now: at(1) });
    expect(displacedDirs(s)).toEqual([`.displaced-${basename(dir)}`]);
  });

  it("keeps a second, different live file as .latest, replaces it next time, and drops identical ones", async () => {
    const s = setup();
    const dir = await snap(s);
    const aside = join(preUpdateDir(s.home), `.displaced-${basename(dir)}`, "state");
    addNote(s.dbPath, "first change");
    restoreWithMarker(dir, s.home, { now: at(1) });
    expect(bodies(join(aside, "psyche.sqlite"))).toEqual(["keep me", "first change"]);

    // Different data than the copy already set aside: it must not be deleted.
    addNote(s.dbPath, "second change");
    restoreWithMarker(dir, s.home, { now: at(2) });
    expect(bodies(join(aside, "psyche.sqlite"))).toEqual(["keep me", "first change"]);
    expect(bodies(join(aside, "psyche.sqlite.latest"))).toEqual(["keep me", "second change"]);

    // And a third: the previous .latest is replaced, so disk use stays bounded.
    addNote(s.dbPath, "third change");
    restoreWithMarker(dir, s.home, { now: at(3) });
    expect(bodies(join(aside, "psyche.sqlite.latest"))).toEqual(["keep me", "third change"]);
    const kept = readdirSync(aside).sort();
    expect(kept.filter((n) => n === "psyche.sqlite.latest")).toHaveLength(1);

    // Byte-for-byte what is already set aside: nothing new is kept.
    const before = readFileSync(join(aside, "psyche.sqlite"));
    writeFileSync(s.dbPath, before);
    restoreWithMarker(dir, s.home, { now: at(4) });
    expect(readdirSync(aside).sort()).toEqual(kept);
  });
});

describe("a retry after a disk-full failure costs no new copy (M3)", () => {
  const diskFull = () => {
    throw new MigrationError('migration "x.sql" failed: database or disk is full', "x");
  };

  it("reuses the snapshot while the data is exactly what it was taken of, and keeps no debris", async () => {
    const s = setup();
    writeFileSync(join(s.migrations, M2), "ALTER TABLE notes ADD COLUMN tag TEXT;");
    await expect(openDbWithSnapshot(base(s, { opener: diskFull }))).rejects.toThrow(
      /put everything back/,
    );
    expect(listSnapshots(s.home)).toHaveLength(1);
    // The same-boot restore replaced the live files in place: no copy of the debris.
    expect(existsSync(preUpdateDir(s.home)) ? displacedDirs(s) : []).toEqual([]);
    for (let lap = 1; lap <= 3; lap++) {
      clearUpdateFailure(s.home);
      await expect(
        openDbWithSnapshot(base(s, { now: at(lap * 10), opener: diskFull })),
      ).rejects.toThrow(/put everything back/);
    }
    // Four attempts, one snapshot, no displaced folders: no two copies of the database per lap.
    expect(listSnapshots(s.home)).toHaveLength(1);
    expect(displacedDirs(s)).toEqual([]);
    expect(bodies(s.dbPath)).toEqual(["keep me"]);
    // And when the disk has room again the update goes through.
    clearUpdateFailure(s.home);
    (await openDbWithSnapshot(base(s, { now: at(60) }))).close();
    expect(listSnapshots(s.home)).toHaveLength(1);
  });

  it("takes a new snapshot when the data changed since", async () => {
    const s = setup();
    writeFileSync(join(s.migrations, M2), "ALTER TABLE notes ADD COLUMN tag TEXT;");
    await expect(openDbWithSnapshot(base(s, { opener: diskFull }))).rejects.toThrow();
    addNote(s.dbPath, "written after the failure");
    clearUpdateFailure(s.home);
    await expect(openDbWithSnapshot(base(s, { now: at(10), opener: diskFull }))).rejects.toThrow();
    expect(listSnapshots(s.home)).toHaveLength(2);
    expect(bodies(s.dbPath)).toEqual(["keep me", "written after the failure"]);
  });
});
