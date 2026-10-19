/**
 * Migration runner for timestamped SQL files (`<YYYYMMDDHHMM>_<package>_<desc>.sql`,
 * docs/09-execution-plan.md §2). Rules:
 * - files are applied in lexicographic order of their names (the 12-digit prefix first);
 * - a file that sorts before an already-applied one is still applied (parallel branches merge
 *   with older timestamps; each package only touches its own tables, so order across packages
 *   does not matter);
 * - each file runs in its own transaction together with its `_migrations` row;
 * - an applied file whose checksum changed, or an applied id with no file, is an error.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { DbLogger } from "./types.ts";

/** Strict migration file name: `202610182200_db_init.sql`, `202610190900_permissions_grants.sql`. */
export const MIGRATION_FILE_PATTERN = /^\d{12}_[a-z0-9-]+_[a-z0-9_-]+\.sql$/;

/** The migrations shipped with this package. */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export interface MigrationFile {
  /** File name without `.sql`; the primary key in `_migrations`. */
  readonly id: string;
  /** File name, e.g. `202610182200_db_init.sql`. */
  readonly name: string;
  readonly path: string;
  readonly sql: string;
  /** `sha256:<hex>` of the file with line endings normalized to `\n`. */
  readonly checksum: string;
}

export interface MigrationResult {
  /** Ids applied by this call, in order. */
  readonly applied: string[];
  /** Ids that were already applied (checksum verified). */
  readonly skipped: string[];
}

export interface MigrateOptions {
  readonly dir?: string;
  readonly logger?: DbLogger;
  readonly now?: () => string;
}

export class MigrationError extends Error {
  readonly migration: string | undefined;

  constructor(message: string, migration?: string) {
    super(message);
    this.name = "MigrationError";
    this.migration = migration;
  }
}

export function checksumOf(sql: string): string {
  return `sha256:${createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex")}`;
}

/**
 * Lists `*.sql` files in `dir`, sorted. Throws `MigrationError` on a `.sql` file whose name does
 * not match {@link MIGRATION_FILE_PATTERN}. Non-SQL files (READMEs) are ignored.
 */
export function listMigrationFiles(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  const names = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".sql"))
    .sort();
  return names.map((name) => {
    if (!MIGRATION_FILE_PATTERN.test(name)) {
      throw new MigrationError(
        `invalid migration file name "${name}": expected <YYYYMMDDHHMM>_<package>_<desc>.sql`,
        name,
      );
    }
    const path = join(dir, name);
    const sql = readFileSync(path, "utf8");
    return { id: name.slice(0, -".sql".length), name, path, sql, checksum: checksumOf(sql) };
  });
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS _migrations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

interface AppliedRow {
  id: string;
  checksum: string;
}

/** Applies pending migrations from `opts.dir` (default: this package's `migrations/`). */
export function runMigrations(
  sqlite: Database.Database,
  opts: MigrateOptions = {},
): MigrationResult {
  const files = listMigrationFiles(opts.dir ?? DEFAULT_MIGRATIONS_DIR);
  const now = opts.now ?? (() => new Date().toISOString());
  sqlite.exec(CREATE_TABLE);

  const appliedRows = sqlite.prepare("SELECT id, checksum FROM _migrations").all() as AppliedRow[];
  const applied = new Map(appliedRows.map((row) => [row.id, row.checksum]));
  const known = new Set(files.map((file) => file.id));
  for (const id of applied.keys()) {
    if (!known.has(id)) {
      throw new MigrationError(
        `database has migration "${id}" that this build does not know (database is newer than the code?)`,
        id,
      );
    }
  }

  const insert = sqlite.prepare(
    "INSERT INTO _migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );
  const result: MigrationResult = { applied: [], skipped: [] };
  for (const file of files) {
    const previous = applied.get(file.id);
    if (previous !== undefined) {
      if (previous !== file.checksum) {
        throw new MigrationError(
          `applied migration "${file.name}" was modified (checksum ${previous} != ${file.checksum}); add a new migration instead`,
          file.id,
        );
      }
      result.skipped.push(file.id);
      continue;
    }
    try {
      sqlite
        .transaction(() => {
          sqlite.exec(file.sql);
          insert.run(file.id, file.name, file.checksum, now());
        })
        .immediate();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new MigrationError(`migration "${file.name}" failed: ${message}`, file.id);
    }
    result.applied.push(file.id);
    opts.logger?.info?.("db.migration.applied", { id: file.id });
  }
  return result;
}
