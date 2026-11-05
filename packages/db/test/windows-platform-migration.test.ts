import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../src/index.ts";
import { makeTmpDir } from "./helpers.ts";

const NEW = "202611050900_db_windows-platform.sql";
const T = "2026-11-05T00:00:00.000Z";

describe("202611050900 windows platform", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function before(): { sqlite: Database.Database; all: string } {
    const { dir, cleanup } = makeTmpDir();
    cleanups.push(cleanup);
    const old = join(dir, "before");
    mkdirSync(old);
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
      if (f.endsWith(".sql") && f < NEW)
        copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(old, f));
    }
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    runMigrations(sqlite, { dir: old });
    return { sqlite, all: DEFAULT_MIGRATIONS_DIR };
  }

  it("rebuilds devices and nodes without running any ON DELETE action, and allows the new values", () => {
    const { sqlite, all } = before();
    const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
    run(
      "INSERT INTO devices (id, name, platform, role, public_key, scopes, paired_at, created_at, updated_at, device_family) VALUES ('d1','Mac','macos','node',x'00','[\"node\"]',?,?,?,'mac-helper')",
      T,
      T,
      T,
    );
    run(
      "INSERT INTO nodes (id, device_id, kind, created_at, updated_at) VALUES ('n1','d1','mac-helper',?,?)",
      T,
      T,
    );
    run(
      "INSERT INTO pairing_requests (id, kind, code, device_id, display, expires_at, created_at, updated_at) VALUES ('p1','device','c','d1','x',?,?,?)",
      T,
      T,
      T,
    );
    expect(() =>
      run(
        "INSERT INTO devices (id, name, platform, role, public_key, created_at, updated_at) VALUES ('d2','PC','windows','node',x'00',?,?)",
        T,
        T,
      ),
    ).toThrow(/CHECK constraint failed/);

    const result = runMigrations(sqlite, { dir: all });
    expect(result.applied).toContain(NEW.slice(0, -4));
    // Foreign keys are back on, and nothing cascaded from the DROPs.
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    const count = (table: string) =>
      (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count("nodes")).toBe(1);
    expect(count("pairing_requests")).toBe(1);
    expect(sqlite.prepare("SELECT device_family FROM devices WHERE id='d1'").get()).toEqual({
      device_family: "mac-helper",
    });

    run(
      "INSERT INTO devices (id, name, platform, role, public_key, created_at, updated_at) VALUES ('d2','PC','windows','node',x'00',?,?)",
      T,
      T,
    );
    run(
      "INSERT INTO nodes (id, device_id, kind, created_at, updated_at) VALUES ('n2','d2','win-helper',?,?)",
      T,
      T,
    );
    expect(() =>
      run(
        "INSERT INTO nodes (id, device_id, kind, created_at, updated_at) VALUES ('n3','d2','bogus',?,?)",
        T,
        T,
      ),
    ).toThrow(/CHECK constraint failed/);
    // References still point at the rebuilt tables: deleting a device cascades to its node.
    run("DELETE FROM devices WHERE id='d2'");
    expect(count("nodes")).toBe(1);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  });
});
