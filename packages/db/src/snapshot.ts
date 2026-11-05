import { existsSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { DEFAULT_MIGRATIONS_DIR, listMigrationFiles } from "./migrate.ts";

/**
 * What the Gateway's pre-update snapshot (apps/gateway `pre-update.ts`) needs from SQLite, kept
 * here so only this package opens database files directly.
 */

/**
 * What the database at a path needs, as far as it can be told without writing:
 * - `none`: no database yet (a new install), or one with every migration applied;
 * - `pending`: these migrations are not applied;
 * - `unknown`: there is a database but it could not be read (locked, corrupt, a layout this
 *   build does not recognise). The caller must treat that as "maybe pending" and protect the
 *   data, never as "nothing to do".
 */
export type MigrationProbe =
  | { state: "none" }
  | { state: "pending"; ids: string[] }
  | { state: "unknown"; reason: string };

export function probeMigrations(
  path: string,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): MigrationProbe {
  if (path === ":memory:" || !existsSync(path) || statSync(path).size === 0)
    return { state: "none" };
  const files = listMigrationFiles(dir);
  let sqlite: Database.Database;
  try {
    sqlite = new Database(path, { fileMustExist: true });
  } catch (err) {
    return { state: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    const table = sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_migrations'")
      .get();
    // A database file with content but no migration table: not what this build wrote.
    if (table === undefined) return { state: "unknown", reason: "no _migrations table" };
    const applied = new Set(
      (sqlite.prepare("SELECT id FROM _migrations").all() as { id: string }[]).map((r) => r.id),
    );
    const ids = files.filter((f) => !applied.has(f.id)).map((f) => f.id);
    return ids.length === 0 ? { state: "none" } : { state: "pending", ids };
  } catch (err) {
    return { state: "unknown", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    sqlite.close();
  }
}

/**
 * The ids of migrations the database has not applied yet. Empty for `none` and for `unknown`:
 * callers that must not fail open use {@link probeMigrations}.
 */
export function pendingMigrationIds(path: string, dir: string = DEFAULT_MIGRATIONS_DIR): string[] {
  const probe = probeMigrations(path, dir);
  return probe.state === "pending" ? probe.ids : [];
}

/**
 * A consistent copy of the SQLite database at `src` in `dest`, made with SQLite's online backup
 * API, so a WAL database is copied whole and correctly even if something else has it open.
 */
export async function backupDatabaseFile(src: string, dest: string): Promise<void> {
  const live = new Database(src, { fileMustExist: true });
  try {
    await live.backup(dest);
  } finally {
    live.close();
  }
}

/**
 * Folds the write-ahead log of the plain SQLite file at `path` into the main file and truncates
 * it. Returns false when the file is not plain SQLite, is locked, or cannot be opened.
 */
export function checkpointDatabaseFile(path: string): boolean {
  let sqlite: Database.Database;
  try {
    sqlite = new Database(path, { fileMustExist: true, timeout: 500 });
  } catch {
    return false;
  }
  try {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    return true;
  } catch {
    return false;
  } finally {
    sqlite.close();
  }
}
