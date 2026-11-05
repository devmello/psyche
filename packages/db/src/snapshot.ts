import {
  closeSync,
  existsSync,
  constants as fsConstants,
  ftruncateSync,
  openSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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
    sqlite = new Database(path, { fileMustExist: true, readonly: true });
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

// --- a lock the kernel releases when the process dies ---------------------------------------

export interface ExclusiveFileLock {
  /** `exlock`: an open() with O_EXLOCK (macOS, BSD). `sqlite`: an exclusive SQLite lock. */
  readonly impl: "exlock" | "sqlite";
  /** Writes the owner's pid for diagnostics only; the lock is the kernel's, not the text. */
  writeNote(text: string): void;
  release(): void;
}

/** `O_EXLOCK` on Darwin and the BSDs; Node does not export it. */
const O_EXLOCK = 0x20;

/**
 * Takes an exclusive, non-blocking lock tied to the open file: the kernel drops it when the
 * process exits for any reason (SIGKILL, power loss, a crash), so there is no stale lock to
 * recognise and nothing to clean up. Returns null when another process holds it. Hold the
 * result for as long as the lock should last.
 *
 * macOS: `open(O_EXLOCK | O_NONBLOCK)` on `path`. Elsewhere (or with `impl: "sqlite"`): an
 * exclusive SQLite lock on `<path>.sqlite`, which SQLite takes with a file lock that the kernel
 * drops the same way.
 */
export function takeExclusiveFileLock(
  path: string,
  impl: "exlock" | "sqlite" = process.platform === "darwin" ? "exlock" : "sqlite",
  /** Test hook: the `open` to use. */
  open: typeof openSync = openSync,
): ExclusiveFileLock | null {
  if (impl === "exlock") {
    let fd: number;
    try {
      fd = open(
        path,
        fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NONBLOCK | O_EXLOCK,
        0o600,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EBUSY") return null;
      // A folder on a volume that cannot lock this way (an external drive, an SMB share): the
      // SQLite lock works through the file locks every such volume offers, or says it cannot.
      if (code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS" || code === "EINVAL")
        return takeExclusiveFileLock(path, "sqlite", open);
      throw err;
    }
    return {
      impl,
      writeNote(text) {
        ftruncateSync(fd, 0);
        writeSync(fd, text, 0);
      },
      release() {
        closeSync(fd);
      },
    };
  }
  const file = `${path}.sqlite`;
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { timeout: 0 });
    db.pragma("locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS gateway_lock (x INTEGER); COMMIT;");
  } catch (err) {
    // A refused attempt must not keep the file open: Windows cannot delete it while it is.
    try {
      db?.close();
    } catch {
      // Already closed.
    }
    const code = (err as { code?: string }).code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return null;
    throw err;
  }
  const held = db as Database.Database;
  return {
    impl,
    writeNote(text) {
      writeFileSync(path, text, { mode: 0o600 });
    },
    release() {
      held.close();
    },
  };
}
