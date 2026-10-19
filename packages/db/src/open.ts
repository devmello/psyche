import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { monotonicFactory } from "ulid";
import { type MigrationResult, runMigrations } from "./migrate.ts";
import { type Schema, schema } from "./schema.ts";
import type { DbLogger } from "./types.ts";

export interface OpenDbOptions {
  /** Open read-only (the file must exist; no pragmas that write, no migrations). */
  readonly readonly?: boolean;
  /** Apply pending migrations on open. Default `true` (`false` when `readonly`). */
  readonly migrate?: boolean;
  /** Directory of `*.sql` migrations. Default: this package's `migrations/`. */
  readonly migrationsDir?: string;
  readonly logger?: DbLogger;
  /** Clock for `created_at` / `updated_at`. Must return ISO-8601 UTC (`Date#toISOString`). */
  readonly now?: () => string;
  /** Id generator. Default: monotonic ULID. */
  readonly newId?: () => string;
}

export interface PsycheDb {
  /** The raw better-sqlite3 connection (synchronous; use for transactions and pragmas). */
  readonly sqlite: Database.Database;
  /** drizzle over the same connection, for typed queries. */
  readonly drizzle: BetterSQLite3Database<Schema>;
  /** Absolute file path, or `":memory:"`. */
  readonly path: string;
  readonly now: () => string;
  readonly newId: () => string;
  /** Applies pending migrations (idempotent). */
  migrate(): MigrationResult;
  close(): void;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Creates missing directories up to `dir`, each with mode 0700 (architecture §14). */
function ensureDir(dir: string): void {
  const missing: string[] = [];
  let current = dir;
  while (!existsSync(current)) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of missing) {
    mkdirSync(path, { mode: DIR_MODE });
    chmodSync(path, DIR_MODE); // mkdir mode is filtered by the umask
  }
}

/**
 * Opens (and by default migrates) the Psyche database. For a real path the parent directory is
 * created with mode 0700 and the file is created / chmod-ed to 0600 before SQLite touches it, so
 * the `-wal` and `-shm` files SQLite derives from it get 0600 too.
 */
export function openDb(path: string, opts: OpenDbOptions = {}): PsycheDb {
  const memory = path === ":memory:";
  const readonly = opts.readonly ?? false;
  const filePath = memory ? path : resolve(path);

  if (!memory && !readonly) {
    ensureDir(dirname(filePath));
    if (!existsSync(filePath)) writeFileSync(filePath, "", { mode: FILE_MODE, flag: "wx" });
    chmodSync(filePath, FILE_MODE);
  }

  const sqlite = new Database(filePath, readonly ? { readonly: true, fileMustExist: true } : {});
  try {
    if (!readonly) {
      if (!memory) sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("synchronous = NORMAL");
    }
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
  } catch (err) {
    sqlite.close();
    throw err;
  }

  const now = opts.now ?? (() => new Date().toISOString());
  const ulid = monotonicFactory();
  const newId = opts.newId ?? (() => ulid());
  const { migrationsDir, logger } = opts;

  const db: PsycheDb = {
    sqlite,
    drizzle: drizzle({ client: sqlite, schema }),
    path: filePath,
    now,
    newId,
    migrate: () => runMigrations(sqlite, { now, dir: migrationsDir, logger }),
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };

  if (opts.migrate ?? !readonly) {
    try {
      db.migrate();
    } catch (err) {
      sqlite.close();
      throw err;
    }
  }
  return db;
}
