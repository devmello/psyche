import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MigrationError, openDb, probeMigrations } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearUpdateFailure,
  createSnapshot,
  finishPendingRestore,
  listSnapshots,
  openDbWithSnapshot,
  pruneSnapshots,
  RESTORE_MARKER_FILE,
  readUpdateFailure,
  restoreSnapshot,
  UPDATE_FAILED_FILE,
  UPDATE_PROGRESS_FILE,
} from "../src/pre-update.ts";

/** Review fixes for the pre-update snapshot: retention, crash-atomic restore, backoff, probes. */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const M1 = "202601010000_test_one.sql";
const M2 = "202601020000_test_two.sql";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "psy-safe-"));
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
const snap = (s: S, n: number) =>
  createSnapshot({ home: s.home, dbPath: s.dbPath, from: "a", to: "b", pending: [], now: at(n) });

describe("retention (M2)", () => {
  it("sorts by sequence, not by a clock that moved back", async () => {
    const s = setup();
    await snap(s, 30);
    await snap(s, 10); // the clock went back
    await snap(s, 20);
    expect(listSnapshots(s.home).map((x) => x.manifest.seq)).toEqual([3, 2, 1]);
  });

  it("deletes nothing younger than 14 days, however many there are", async () => {
    const s = setup();
    for (let i = 0; i < 4; i++) await snap(s, i);
    expect(pruneSnapshots(s.home, { keep: 2, now: at(5)() })).toEqual([]);
    const later = new Date(Date.UTC(2026, 10, 25));
    expect(pruneSnapshots(s.home, { keep: 2, now: later })).toHaveLength(2);
    expect(listSnapshots(s.home).map((x) => x.manifest.seq)).toEqual([4, 3]);
  });

  it("never deletes one newer than the last good boot, nor the newest", async () => {
    const s = setup();
    for (let i = 0; i < 4; i++) await snap(s, i);
    const later = new Date(Date.UTC(2026, 11, 25));
    expect(pruneSnapshots(s.home, { keep: 1, now: later, goodSeq: 2, minAgeMs: 0 })).toHaveLength(
      2,
    );
    expect(listSnapshots(s.home).map((x) => x.manifest.seq)).toEqual([4, 3]);
    expect(pruneSnapshots(s.home, { keep: 0, now: later, goodSeq: 0, minAgeMs: 0 })).toEqual([]);
  });

  it("prunes only after a boot that worked: a failed one keeps every snapshot", async () => {
    const s = setup();
    s.put({ [M2]: "SELECT * FROM table_that_is_not_there;" });
    for (let i = 0; i < 3; i++)
      await expect(
        openDbWithSnapshot(base(s, { now: at(i), build: `b${i}`, keep: 1, minPruneAgeMs: 0 })),
      ).rejects.toThrow();
    expect(listSnapshots(s.home)).toHaveLength(3);
    s.put({ [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;" });
    (
      await openDbWithSnapshot(base(s, { now: at(9), build: "b9", keep: 1, minPruneAgeMs: 0 }))
    ).close();
    expect(listSnapshots(s.home)).toHaveLength(1);
  });

  it("reuses the snapshot of a boot that never finished instead of copying half-migrated data", async () => {
    const s = setup();
    s.put({ [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;" });
    // The process died in the middle: the data was changed, no failure was recorded.
    const crashing = (path: string) => {
      const d = openDb(path, { migrate: false, migrationsDir: s.migrations });
      d.sqlite.prepare("DELETE FROM notes").run();
      d.close();
      throw new Error("killed");
    };
    await expect(openDbWithSnapshot(base(s, { opener: crashing }))).rejects.toThrow("killed");
    expect(listSnapshots(s.home)).toHaveLength(1);
    expect(bodies(s.dbPath)).toEqual([]);
    // The next start finds the same version and build with no good boot in between.
    (await openDbWithSnapshot(base(s, { now: at(5) }))).close();
    expect(listSnapshots(s.home)).toHaveLength(1);
    expect(bodies(s.dbPath)).toEqual(["keep me"]);
  });
});

describe("crash-atomic restore (M3)", () => {
  it("finishes a restore that a crash cut short, before anything else", async () => {
    const s = setup();
    const dir = await snap(s, 0);
    // The crash: the marker was written, the live database was already wrecked.
    const wreck = new DatabaseSync(s.dbPath);
    wreck.exec("DELETE FROM notes");
    wreck.close();
    mkdirSync(join(s.home, "run"), { recursive: true });
    writeFileSync(
      join(s.home, RESTORE_MARKER_FILE),
      JSON.stringify({ snapshot: dir, at: "x", allowAbsolute: [] }),
    );
    expect(finishPendingRestore(s.home)).toBe(true);
    expect(bodies(s.dbPath)).toEqual(["keep me"]);
    expect(existsSync(join(s.home, RESTORE_MARKER_FILE))).toBe(false);
    expect(finishPendingRestore(s.home)).toBe(false);
  });

  it("does it at the start of boot, even with nothing pending", async () => {
    const s = setup();
    const dir = await snap(s, 0);
    const wreck = new DatabaseSync(s.dbPath);
    wreck.exec("DELETE FROM notes");
    wreck.close();
    mkdirSync(join(s.home, "run"), { recursive: true });
    writeFileSync(
      join(s.home, RESTORE_MARKER_FILE),
      JSON.stringify({ snapshot: dir, at: "x", allowAbsolute: [] }),
    );
    (await openDbWithSnapshot(base(s))).close();
    expect(bodies(s.dbPath)).toEqual(["keep me"]);
  });

  it("refuses to start when it cannot finish an interrupted restore", async () => {
    const s = setup();
    mkdirSync(join(s.home, "run"), { recursive: true });
    writeFileSync(
      join(s.home, RESTORE_MARKER_FILE),
      JSON.stringify({ snapshot: join(s.home, "gone"), at: "x", allowAbsolute: [] }),
    );
    await expect(openDbWithSnapshot(base(s))).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "restore_interrupted" },
    });
  });

  it("leaves no marker behind after a restore that worked", async () => {
    const s = setup();
    s.put({ [M2]: "SELECT * FROM table_that_is_not_there;" });
    await expect(openDbWithSnapshot(base(s))).rejects.toThrow();
    expect(existsSync(join(s.home, RESTORE_MARKER_FILE))).toBe(false);
  });

  it("checksums the encrypted store's log and refuses a damaged one without touching anything", async () => {
    const s = setup();
    writeFileSync(join(s.home, "state", "memory.sqlite"), "ciphertext");
    writeFileSync(join(s.home, "state", "memory.sqlite-wal"), "log");
    const dir = await snap(s, 0);
    writeFileSync(join(dir, "files", "state", "memory.sqlite-wal"), "tampered");
    writeFileSync(join(s.home, "state", "memory.sqlite"), "changed since");
    expect(() => restoreSnapshot(dir, s.home)).toThrow(/damaged/);
    expect(readFileSync(join(s.home, "state", "memory.sqlite"), "utf8")).toBe("changed since");
  });

  it("restores a file with its log and removes a stale index and temp files", async () => {
    const s = setup();
    writeFileSync(join(s.home, "state", "memory.sqlite"), "ciphertext");
    writeFileSync(join(s.home, "state", "memory.sqlite-wal"), "log");
    const dir = await snap(s, 0);
    writeFileSync(join(s.home, "state", "memory.sqlite"), "newer");
    writeFileSync(join(s.home, "state", "memory.sqlite-wal"), "newer log");
    writeFileSync(join(s.home, "state", "memory.sqlite-shm"), "stale index");
    restoreSnapshot(dir, s.home);
    expect(readFileSync(join(s.home, "state", "memory.sqlite"), "utf8")).toBe("ciphertext");
    expect(readFileSync(join(s.home, "state", "memory.sqlite-wal"), "utf8")).toBe("log");
    expect(existsSync(join(s.home, "state", "memory.sqlite-shm"))).toBe(false);
    expect(existsSync(join(s.home, "state", "memory.sqlite.restoring"))).toBe(false);
  });

  it("compares allowed absolute paths after resolving both sides (L8)", async () => {
    const s = setup();
    const outside = join(s.root, "elsewhere");
    mkdirSync(outside);
    const db = openDb(join(outside, "psyche.sqlite"), { migrationsDir: s.migrations });
    db.close();
    const dir = await createSnapshot({
      home: s.home,
      dbPath: join(outside, "psyche.sqlite"),
      from: "a",
      to: "b",
      pending: [],
      now: at(0),
    });
    // The same place, spelled with a detour.
    const detour = join(outside, "..", "elsewhere", ".", "psyche.sqlite");
    expect(() => restoreSnapshot(dir, s.home, { allowAbsolute: [detour] })).not.toThrow();
    const link = join(s.root, "link");
    symlinkSync(outside, link);
    expect(relative(s.root, link)).toBe("link");
  });
});

describe("failures and retries (M5)", () => {
  const failing = (message: string) => () => {
    throw new MigrationError(`migration "x.sql" failed: ${message}`, "x");
  };

  it("backs off after an error from the machine and tries again once the time is up", async () => {
    const s = setup();
    s.put({ [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;" });
    await expect(
      openDbWithSnapshot(base(s, { opener: failing("database or disk is full") })),
    ).rejects.toThrow(/put everything back/);
    const note = readUpdateFailure(s.home);
    expect(note).toMatchObject({ kind: "environment", attempts: 1, restored: true });
    expect(Date.parse(note?.retryAfter ?? "")).toBeGreaterThan(at(0)().getTime());
    // Too soon: refused with the stored message, no new attempt.
    await expect(openDbWithSnapshot(base(s, { now: at(1) }))).rejects.toThrow(note?.message ?? "");
    expect(listSnapshots(s.home)).toHaveLength(1);
    // After the backoff the update goes through.
    (await openDbWithSnapshot(base(s, { now: at(10) }))).close();
    expect(readUpdateFailure(s.home)).toBeUndefined();
  });

  it("doubles the backoff on each repeat", async () => {
    const s = setup();
    s.put({ [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;" });
    const opener = failing("disk I/O error");
    await expect(openDbWithSnapshot(base(s, { opener }))).rejects.toThrow();
    const first = readUpdateFailure(s.home);
    await expect(openDbWithSnapshot(base(s, { opener, now: at(10) }))).rejects.toThrow();
    const second = readUpdateFailure(s.home);
    expect(second?.attempts).toBe(2);
    const gap = (n: typeof first) => Date.parse(n?.retryAfter ?? "") - Date.parse(n?.at ?? "");
    expect(gap(second)).toBe(gap(first) * 2);
  });

  it("blocks a broken migration for good, until the owner says try again", async () => {
    const s = setup();
    s.put({ [M2]: "SELECT * FROM table_that_is_not_there;" });
    await expect(openDbWithSnapshot(base(s))).rejects.toThrow();
    expect(readUpdateFailure(s.home)).toMatchObject({ kind: "deterministic", retryAfter: null });
    await expect(openDbWithSnapshot(base(s, { now: at(600) }))).rejects.toThrow(/put everything/);
    expect(listSnapshots(s.home)).toHaveLength(1);
    expect(clearUpdateFailure(s.home)).toBe(true);
    expect(clearUpdateFailure(s.home)).toBe(false);
    s.put({ [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;" });
    (await openDbWithSnapshot(base(s, { now: at(601) }))).close();
  });

  it("tells the truth when the data could not be put back: the stored message, and no retry", async () => {
    const s = setup();
    s.put({ [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;" });
    const opener = (path: string) => {
      // The snapshot is damaged before the failure, so the restore cannot happen.
      const snapshot = listSnapshots(s.home)[0];
      writeFileSync(join(snapshot?.dir ?? "", "files", "state", "psyche.sqlite"), "damaged");
      void path;
      throw new MigrationError('migration "x.sql" failed: boom', "x");
    };
    await expect(openDbWithSnapshot(base(s, { opener }))).rejects.toThrow(
      /could not put it back automatically/,
    );
    const note = readUpdateFailure(s.home);
    expect(note).toMatchObject({ restored: false, retryAfter: null });
    await expect(openDbWithSnapshot(base(s, { now: at(999) }))).rejects.toThrow(
      /could not put it back automatically/,
    );
  });

  it("keys a dev build by version and pending migrations, with a backoff", async () => {
    const s = setup();
    s.put({ [M2]: "SELECT * FROM table_that_is_not_there;" });
    await expect(openDbWithSnapshot(base(s, { build: "dev" }))).rejects.toThrow();
    const note = readUpdateFailure(s.home);
    expect(note?.key).toMatch(/^dev:0\.5\.0:[0-9a-f]{12}$/);
    expect(Date.parse(note?.retryAfter ?? "")).toBeGreaterThan(at(0)().getTime());
    await expect(openDbWithSnapshot(base(s, { build: "dev", now: at(1) }))).rejects.toThrow();
    expect(listSnapshots(s.home)).toHaveLength(1);
    // A different set of pending migrations is a different failure: it is tried at once.
    s.put({
      [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;",
      "202601030000_test_three.sql": "CREATE TABLE z (id INTEGER);",
    });
    (await openDbWithSnapshot(base(s, { build: "dev", now: at(2) }))).close();
  });

  it("writes a note when the safety copy cannot be made, and waits before trying again", async () => {
    const s = setup();
    s.put({ [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;" });
    writeFileSync(join(s.home, "backups"), "in the way");
    await expect(openDbWithSnapshot(base(s))).rejects.toMatchObject({
      details: { reason: "snapshot_failed" },
    });
    expect(readUpdateFailure(s.home)).toMatchObject({
      kind: "environment",
      message: expect.stringContaining("Try again"),
    });
    expect(existsSync(join(s.home, UPDATE_FAILED_FILE))).toBe(true);
    expect(existsSync(join(s.home, UPDATE_PROGRESS_FILE))).toBe(false);
    rmSync(join(s.home, "backups"));
    clearUpdateFailure(s.home);
    (await openDbWithSnapshot(base(s, { now: at(1) }))).close();
  });

  it("shows progress while a snapshot and the migrations run", async () => {
    const s = setup();
    s.put({ [M2]: "ALTER TABLE notes ADD COLUMN tag TEXT;" });
    let during: unknown;
    const opener = (path: string, opts?: Parameters<typeof openDb>[1]) => {
      during = JSON.parse(readFileSync(join(s.home, UPDATE_PROGRESS_FILE), "utf8"));
      return openDb(path, opts);
    };
    (await openDbWithSnapshot(base(s, { opener }))).close();
    expect(during).toMatchObject({ phase: "migrating", build: "build-b" });
    expect(existsSync(join(s.home, UPDATE_PROGRESS_FILE))).toBe(false);
  });
});

describe("a database that cannot be read (M7)", () => {
  it("is 'unknown', never 'nothing to do'", () => {
    const s = setup();
    const bad = join(s.home, "state", "broken.sqlite");
    writeFileSync(bad, "this is not a database at all, but it has content");
    expect(probeMigrations(bad, s.migrations).state).toBe("unknown");
    // Content, but not a database this build wrote (no migration table).
    const foreign = join(s.home, "state", "foreign.sqlite");
    const other = new DatabaseSync(foreign);
    other.exec("CREATE TABLE something_else (id INTEGER)");
    other.close();
    expect(probeMigrations(foreign, s.migrations)).toMatchObject({ state: "unknown" });
    expect(probeMigrations(s.dbPath, s.migrations).state).toBe("none");
    expect(probeMigrations(join(s.root, "none.sqlite"), s.migrations).state).toBe("none");
  });

  it("snapshots anyway, and keeps the snapshot of an unreadable file as it is", async () => {
    const s = setup();
    writeFileSync(s.dbPath, "this is not a database at all, but it has content");
    await expect(openDbWithSnapshot(base(s))).rejects.toThrow();
    const [first] = listSnapshots(s.home);
    expect(first?.manifest.probe).toBeDefined();
    expect(first?.manifest.entries.find((e) => e.rel === "state/psyche.sqlite")?.kind).toBe("file");
    // The owner repairs the file by hand; the next start does not put the broken copy back.
    writeFileSync(s.dbPath, "repaired by hand");
    await expect(openDbWithSnapshot(base(s, { now: at(1) }))).rejects.toThrow();
    expect(listSnapshots(s.home)).toHaveLength(1);
    expect(readFileSync(s.dbPath, "utf8")).toBe("repaired by hand");
  });
});
