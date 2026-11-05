import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../src/index.ts";
import { makeTmpDir } from "./helpers.ts";

const NEW = "202611051300_db_host-helper-node-kind.sql";
const T = "2026-11-05T00:00:00.000Z";
const INSERT_NODE =
  "INSERT INTO nodes (id, device_id, kind, created_at, updated_at) VALUES (?, 'd1', ?, ?, ?)";

describe("202611051300 host-helper node kind", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  it("keeps existing nodes, and allows host-helper and guest", () => {
    const { dir, cleanup } = makeTmpDir();
    cleanups.push(cleanup);
    const old = join(dir, "before");
    mkdirSync(old);
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
      if (f.endsWith(".sql") && f < NEW) {
        copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(old, f));
      }
    }
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    runMigrations(sqlite, { dir: old });
    const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
    run(
      "INSERT INTO devices (id, name, platform, role, public_key, scopes, paired_at, created_at, updated_at, device_family) VALUES ('d1', 'Mac', 'macos', 'node', x'00', '[\"node\"]', ?, ?, ?, 'mac-helper')",
      T,
      T,
      T,
    );
    run(INSERT_NODE, "n1", "mac-helper", T, T);
    expect(() => run(INSERT_NODE, "n2", "host-helper", T, T)).toThrow(/CHECK/);

    runMigrations(sqlite, { dir: DEFAULT_MIGRATIONS_DIR });
    expect(sqlite.prepare("SELECT id, kind FROM nodes").all()).toEqual([
      { id: "n1", kind: "mac-helper" },
    ]);
    run(INSERT_NODE, "n2", "host-helper", T, T);
    run(INSERT_NODE, "n3", "guest", T, T);
    expect(() => run(INSERT_NODE, "n4", "bogus", T, T)).toThrow(/CHECK/);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  });
});
