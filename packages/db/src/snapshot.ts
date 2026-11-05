import { existsSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { DEFAULT_MIGRATIONS_DIR, listMigrationFiles } from "./migrate.ts";

/**
 * What the Gateway's pre-update snapshot (apps/gateway `pre-update.ts`) needs from SQLite, kept
 * here so only this package opens database files directly.
 */

/**
 * The ids of migrations in `dir` (default: this package's) that the database at `path` has not
 * applied. `[]` when there is nothing to protect: no database yet, an empty file, or one that has
 * never been migrated. Opens the file and reads; never writes.
 */
export function pendingMigrationIds(path: string, dir: string = DEFAULT_MIGRATIONS_DIR): string[] {
  if (path === ":memory:" || !existsSync(path) || statSync(path).size === 0) return [];
  const files = listMigrationFiles(dir);
  let sqlite: Database.Database;
  try {
    sqlite = new Database(path, { fileMustExist: true });
  } catch {
    return []; // openDb will say what is wrong with the file
  }
  try {
    const table = sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_migrations'")
      .get();
    if (table === undefined) return [];
    const applied = new Set(
      (sqlite.prepare("SELECT id FROM _migrations").all() as { id: string }[]).map((r) => r.id),
    );
    return files.filter((f) => !applied.has(f.id)).map((f) => f.id);
  } catch {
    return [];
  } finally {
    sqlite.close();
  }
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
