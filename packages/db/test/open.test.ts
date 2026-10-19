import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listMigrationFiles, openDb } from "../src/index.ts";
import { makeTmpDir, memoryDb } from "./helpers.ts";

const TABLES = [
  "approvals",
  "automation_runs",
  "automations",
  "channels",
  "chat_queue",
  "devices",
  "gateway_idempotency",
  "grants",
  "identities",
  "input_requests",
  "memory_chunks",
  "memory_claims",
  "memory_files",
  "memory_jobs",
  "memory_state",
  "messages",
  "nodes",
  "pairing_requests",
  "policy_rules",
  "receipts",
  "runs",
  "settings",
  "skills",
  "task_actions",
  "task_checkpoints",
  "tasks",
  "threads",
  "tool_calls",
  "tool_payloads",
  "usage",
  "watches",
];

function tableNames(db: ReturnType<typeof memoryDb>): string[] {
  return (
    (
      db.sqlite
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' ORDER BY name",
        )
        .all() as { name: string; sql: string }[]
    )
      // Virtual tables (FTS5) and their shadow tables are not listed.
      .filter((r, _, all) => {
        const virtual = all.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql));
        return !virtual.some((v) => r.name === v.name || r.name.startsWith(`${v.name}_`));
      })
      .map((r) => r.name)
  );
}

describe("openDb", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("creates schema v0 in memory with foreign keys on", () => {
    const db = memoryDb();
    // Other packages add their own tables through later migrations.
    expect(tableNames(db)).toEqual(expect.arrayContaining(TABLES));
    expect(db.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(db.sqlite.pragma("journal_mode", { simple: true })).toBe("memory");
    db.close();
  });

  it("bundles FTS5 (needed by S06/S01 search)", () => {
    const db = memoryDb({ migrate: false });
    db.sqlite.exec("CREATE VIRTUAL TABLE t USING fts5(body)");
    db.close();
  });

  it("creates an on-disk db in WAL mode with private modes", () => {
    const tmp = makeTmpDir();
    cleanup = tmp.cleanup;
    const dir = join(tmp.dir, "home", "state");
    const file = join(dir, "psyche.sqlite");
    const db = openDb(file);
    // Other packages add their own tables through later migrations.
    expect(tableNames(db)).toEqual(expect.arrayContaining(TABLES));
    expect(db.path).toBe(file);
    expect(db.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.sqlite.pragma("synchronous", { simple: true })).toBe(1); // NORMAL
    db.sqlite.prepare("INSERT INTO settings VALUES ('a', '1', 'x', 'x')").run();
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(`${file}-wal`).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(tmp.dir, "home")).mode & 0o777).toBe(0o700);
    }
    db.close();

    const again = openDb(file);
    expect(again.migrate()).toEqual({
      applied: [],
      skipped: listMigrationFiles().map((f) => f.id),
    });
    again.close();

    const ro = openDb(file, { readonly: true });
    expect(ro.sqlite.readonly).toBe(true);
    expect(tableNames(ro)).toEqual(expect.arrayContaining(TABLES));
    ro.close();
  });
});
