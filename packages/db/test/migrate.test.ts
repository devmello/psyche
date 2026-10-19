import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MIGRATIONS_DIR,
  listMigrationFiles,
  MigrationError,
  openDb,
  runMigrations,
} from "../src/index.ts";
import { makeTmpDir, memoryDb } from "./helpers.ts";

describe("migrations", () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => {
    const tmp = makeTmpDir();
    cleanup = tmp.cleanup;
    dir = join(tmp.dir, "migrations");
    mkdirSync(dir);
  });
  afterEach(() => cleanup());

  it("ships the init migration with a valid name", () => {
    const files = listMigrationFiles();
    expect(files.map((f) => f.name)).toContain("202610182200_db_init.sql");
    expect(files[0]?.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("applies once and is idempotent", () => {
    copyFileSync(
      join(DEFAULT_MIGRATIONS_DIR, "202610182200_db_init.sql"),
      join(dir, "202610182200_db_init.sql"),
    );
    const db = openDb(":memory:", { migrationsDir: dir, migrate: false });
    expect(db.migrate()).toEqual({ applied: ["202610182200_db_init"], skipped: [] });
    expect(db.migrate()).toEqual({ applied: [], skipped: ["202610182200_db_init"] });
    const rows = db.sqlite.prepare("SELECT id, name, checksum FROM _migrations").all();
    expect(rows).toHaveLength(1);
    db.close();
  });

  it("orders files by their timestamp prefix and applies late-merged older files", () => {
    writeFileSync(join(dir, "202610190900_b_second.sql"), "CREATE TABLE b (id TEXT);");
    writeFileSync(join(dir, "202610180900_a_first.sql"), "CREATE TABLE a (id TEXT);");
    expect(listMigrationFiles(dir).map((f) => f.id)).toEqual([
      "202610180900_a_first",
      "202610190900_b_second",
    ]);
    const db = openDb(":memory:", { migrationsDir: dir });
    writeFileSync(join(dir, "202610181000_c_late-merge.sql"), "CREATE TABLE c (id TEXT);");
    expect(db.migrate()).toEqual({
      applied: ["202610181000_c_late-merge"],
      skipped: ["202610180900_a_first", "202610190900_b_second"],
    });
    db.close();
  });

  it("detects a modified applied migration", () => {
    const file = join(dir, "202610180900_a_first.sql");
    writeFileSync(file, "CREATE TABLE a (id TEXT);");
    const db = openDb(":memory:", { migrationsDir: dir });
    writeFileSync(file, "CREATE TABLE a (id TEXT, extra TEXT);");
    expect(() => db.migrate()).toThrow(MigrationError);
    expect(() => db.migrate()).toThrow(/was modified/);
    db.close();
  });

  it("treats CRLF and LF checkouts as the same migration", () => {
    const file = join(dir, "202610180900_a_first.sql");
    writeFileSync(file, "CREATE TABLE a (id TEXT);\n");
    const db = openDb(":memory:", { migrationsDir: dir });
    writeFileSync(file, "CREATE TABLE a (id TEXT);\r\n");
    expect(db.migrate().skipped).toEqual(["202610180900_a_first"]);
    db.close();
  });

  it("rejects a database that has migrations this build does not know", () => {
    const file = join(dir, "202610180900_a_first.sql");
    writeFileSync(file, "CREATE TABLE a (id TEXT);");
    const db = openDb(":memory:", { migrationsDir: dir });
    db.sqlite
      .prepare("INSERT INTO _migrations VALUES ('209901010000_x_future', 'x', 'sha256:0', 'now')")
      .run();
    expect(() => db.migrate()).toThrow(/does not know/);
    db.close();
  });

  it.each([
    "20261018_db_init.sql",
    "202610182200_init.sql",
    "202610182200_DB_init.sql",
    "202610182200_db_init.SQL",
    "202610182200_db_in it.sql",
  ])("rejects bad file name %s", (name) => {
    writeFileSync(join(dir, name), "SELECT 1;");
    expect(() => listMigrationFiles(dir)).toThrow(/invalid migration file name/);
  });

  it("ignores non-SQL files", () => {
    writeFileSync(join(dir, "README.md"), "# notes");
    expect(listMigrationFiles(dir)).toEqual([]);
  });

  it("rolls back a failing migration entirely", () => {
    writeFileSync(
      join(dir, "202610180900_a_broken.sql"),
      "CREATE TABLE a (id TEXT); INSERT INTO nope VALUES (1);",
    );
    const db = openDb(":memory:", { migrationsDir: dir, migrate: false });
    expect(() => db.migrate()).toThrow(/202610180900_a_broken\.sql" failed/);
    const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").all();
    expect(tables).toEqual([]);
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM _migrations").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("concurrent migrators", () => {
  it("skips a migration another connection applied after this one listed the table", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const file = join(dir, "race.sqlite");
      const a = new Database(file);
      const b = new Database(file);
      // `a` creates the bookkeeping table, then `b` applies everything before `a` gets the lock.
      a.exec(
        "CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
      );
      const original = a.prepare.bind(a);
      let raced = false;
      a.prepare = ((sql: string) => {
        const stmt = original(sql);
        if (!raced && sql.startsWith("SELECT id, checksum FROM _migrations")) {
          raced = true;
          const rows = stmt.all();
          runMigrations(b);
          return { all: () => rows } as unknown as ReturnType<typeof original>;
        }
        return stmt;
      }) as typeof a.prepare;
      const result = runMigrations(a);
      expect(result.applied).toEqual([]);
      expect(result.skipped.length).toBeGreaterThan(0);
      a.close();
      b.close();
    } finally {
      cleanup();
    }
  });
});

describe("notifications migration (registered from @psyche/notifications)", () => {
  it("applies over a database whose notifications tables already exist", () => {
    const db = memoryDb();
    expect(
      db.sqlite
        .prepare("SELECT 1 FROM _migrations WHERE id = '202610190200_notifications_init'")
        .get(),
    ).toBeDefined();
    // Databases created before the file was registered: tables present, ledger row absent.
    db.sqlite.prepare("DELETE FROM _migrations WHERE id = '202610190200_notifications_init'").run();
    expect(db.migrate().applied).toEqual(["202610190200_notifications_init"]);
    db.close();
  });
});
