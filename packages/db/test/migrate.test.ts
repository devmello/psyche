import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MIGRATIONS_DIR,
  listMigrationFiles,
  MigrationError,
  openDb,
} from "../src/index.ts";
import { makeTmpDir } from "./helpers.ts";

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
