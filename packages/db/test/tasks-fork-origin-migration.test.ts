import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../src/index.ts";
import { makeTmpDir } from "./helpers.ts";

const NEW = "202611241300_tasks_fork-origin.sql";
const T = "2026-11-24T00:00:00.000Z";
const INSERT_TASK = `INSERT INTO tasks (id, thread_id, title, goal, created_from, created_at, updated_at,
  staging, taint_sources, workspace, specialist, lessons_applied, summary, taint)
  VALUES (?, 'th1', 'Title', 'Goal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

describe("202611241300 tasks fork origin", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  it("keeps every task column and child row, and allows created_from 'fork'", () => {
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
    const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
    run(
      "INSERT INTO threads (id, kind, session_key, created_at, updated_at) VALUES ('th1', 'main', 's', ?, ?)",
      T,
      T,
    );
    const staging = JSON.stringify({ kind: "night", nightId: "night_1" });
    const sources = JSON.stringify([{ kind: "web", ref: "https://example.org" }]);
    run(
      INSERT_TASK,
      "t1",
      "chat",
      T,
      T,
      staging,
      sources,
      "vm",
      '{"role":"r"}',
      '["l1"]',
      "sum",
      1,
    );
    run(
      "INSERT INTO task_checkpoints (id, task_id, step_id, idx, replay_safe, status, created_at, updated_at) VALUES ('c1', 't1', 's1', 0, 1, 'done', ?, ?)",
      T,
      T,
    );
    expect(() =>
      run(INSERT_TASK, "t2", "fork", T, T, null, null, null, null, null, null, 0),
    ).toThrow(/CHECK/);
    const before = sqlite.prepare("SELECT * FROM tasks WHERE id = 't1'").get();

    runMigrations(sqlite, { dir: DEFAULT_MIGRATIONS_DIR });

    // Every column of the old row, unchanged (write-then-read on the real table).
    expect(sqlite.prepare("SELECT * FROM tasks WHERE id = 't1'").get()).toEqual(before);
    expect(sqlite.prepare("SELECT id, task_id FROM task_checkpoints").all()).toEqual([
      { id: "c1", task_id: "t1" },
    ]);
    const fork = JSON.stringify({ kind: "fork", forkId: "f1", branchId: "b1" });
    run(INSERT_TASK, "t2", "fork", T, T, fork, null, null, null, null, null, 0);
    expect(sqlite.prepare("SELECT created_from, staging FROM tasks WHERE id = 't2'").get()).toEqual(
      {
        created_from: "fork",
        staging: fork,
      },
    );
    expect(() =>
      run(INSERT_TASK, "t3", "bogus", T, T, null, null, null, null, null, null, 0),
    ).toThrow(/CHECK/);
    // The other checks and the indexes are still there, and deleting a thread still cascades.
    expect(() =>
      run(INSERT_TASK, "t4", "chat", T, T, "not json", null, null, null, null, null, 0),
    ).toThrow(/CHECK/);
    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(indexes).toEqual(
      expect.arrayContaining(["tasks_claim_idx", "tasks_thread_id_idx", "tasks_updated_at_idx"]),
    );
    run("DELETE FROM threads WHERE id = 'th1'");
    expect(sqlite.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM task_checkpoints").get()).toEqual({ n: 0 });
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  });
});
