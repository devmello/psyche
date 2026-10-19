import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThread, openDb, type PsycheDb } from "@psyche/db";
import type { Clock } from "@psyche/protocol";
import { createIdGenerator, FakeClock } from "@psyche/testing";
import { SqliteTaskEngine, type SqliteTaskEngineOptions } from "../src/index.ts";

export const THREAD = "thr_test";

/** An in-memory (or on-disk) database with the S04 migrations and one thread. */
export function testDb(clock: Clock, path = ":memory:", threadIds: string[] = [THREAD]): PsycheDb {
  const ids = createIdGenerator({ prefix: "db" });
  const db = openDb(path, {
    now: () => new Date(clock.now()).toISOString(),
    newId: () => ids.next(),
  });
  for (const id of threadIds) {
    if (db.sqlite.prepare("SELECT 1 FROM threads WHERE id = ?").get(id) === undefined) {
      createThread(db, { id, kind: "main", sessionKey: `main:${id}` });
    }
  }
  return db;
}

export function testEngine(
  options: { clock?: FakeClock; db?: PsycheDb } & Partial<SqliteTaskEngineOptions> = {},
) {
  const clock = options.clock ?? new FakeClock();
  const db = options.db ?? testDb(clock);
  const ids = createIdGenerator({ prefix: "t" });
  const engine = new SqliteTaskEngine({ newId: () => ids.next(), ...options, db, clock });
  return { engine, clock, db };
}

/** A temp dir for on-disk databases; call `cleanup` in afterEach. */
export function tmpDir(): { dir: string; file: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-tasks-")));
  return {
    dir,
    file: join(dir, "psyche.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
