import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backupsDir } from "@psyche/backup";
import {
  backupDatabaseFile,
  MigrationError,
  type OpenDbOptions,
  openDb,
  type PsycheDb,
  pendingMigrationIds,
} from "@psyche/db";
import { PsycheError } from "@psyche/protocol";
import { serverBuild } from "./build-info.ts";
import type { Logger } from "./log.ts";

/**
 * The snapshot in front of pending migrations (updates design §2.7, gap G2).
 *
 * Migrations run forward-only at boot, and nothing could undo one. So when the database has
 * migrations the new build will apply, every database and `config.json` are copied first into
 * `$PSYCHE_HOME/backups/pre-update/<from>-to-<to>-<time>/`. If a migration then fails, the
 * snapshot is put back and the Gateway refuses to start with a plain message, instead of running
 * on a half-migrated database. The newest few snapshots are kept (default 3).
 *
 * SQLite files are copied with SQLite's online backup API (consistent under WAL), not as bytes.
 * A file that is not plain SQLite (the memory store is encrypted) is copied as is, with its
 * `-wal` and `-shm` beside it, which is safe because nothing has opened it yet at this point of
 * the boot. Not copied: `workspace/`, `library/`, `browser/` (large, and never migrated),
 * `state/teach` (the owner's recordings) and `security/` (revocations must replay after a
 * restore, so they are never rolled back).
 *
 * Not encrypted beyond what the files already are: it sits beside the live files, with the same
 * exposure. It is not `psyche backup`, which stays the portable, encrypted copy.
 */

export const PRE_UPDATE_DIR = "pre-update";
export const MANIFEST_FILE = "manifest.json";
/** Written beside the Gateway's other run files when a migration failed and was undone. */
export const UPDATE_FAILED_FILE = join("run", "update-failed.json");
/** Where the Gateway remembers which build last opened this data. */
export const LAST_BOOT_FILE = join("state", "last-boot.json");
export const DEFAULT_KEEP = 3;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
const SIDECARS = ["-wal", "-shm", "-journal"] as const;
const DB_NAME = /\.(sqlite3?|db)$/;
/** Folders searched for databases; `state/teach` holds the owner's recordings and is skipped. */
const DB_ROOTS = ["state", "vault"] as const;
const SKIP_DIRS = new Set([join("state", "teach")]);

export interface SnapshotEntry {
  /** Home-relative path (forward slashes) of the live file. */
  rel: string;
  kind: "sqlite" | "file";
  bytes: number;
  sha256: string;
  /** Set for a file outside `$PSYCHE_HOME` (a `PSYCHE_DB` override): where it lives, absolute. */
  abs?: string;
  /** Where it is inside the snapshot (`files/...`). */
  stored: string;
}

export interface SnapshotManifest {
  format: "psyche-pre-update";
  version: 1;
  createdAt: string;
  from: string;
  to: string;
  build?: string;
  /** The migration ids this update was about to apply. */
  pending: string[];
  entries: SnapshotEntry[];
}

export interface SnapshotRequest {
  home: string;
  /** The main database (`config.dbPath`); copied wherever it is. */
  dbPath: string;
  from: string;
  to: string;
  build?: string;
  pending: string[];
  now?: () => Date;
}

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

function isPlainSqlite(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(SQLITE_MAGIC.length);
    return readSync(fd, head, 0, head.length, 0) === head.length && head.equals(SQLITE_MAGIC);
  } finally {
    closeSync(fd);
  }
}

/** Every database file under `state/` and `vault/` (never a `-wal`, `-shm` or `-journal`). */
export function findDatabases(home: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(home, rel);
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const childRel = join(rel, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(join(home, childRel));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(childRel)) walk(childRel);
      } else if (st.isFile() && DB_NAME.test(name) && st.size > 0) {
        out.push(childRel.split(sep).join("/"));
      }
    }
  };
  for (const root of DB_ROOTS) walk(root);
  return out;
}

function dirName(from: string, to: string, at: Date): string {
  const safe = (v: string) => v.replace(/[^A-Za-z0-9._+-]/g, "_").slice(0, 40) || "unknown";
  return `${safe(from)}-to-${safe(to)}-${at.toISOString().replace(/[:.]/g, "-")}`;
}

export function preUpdateDir(home: string): string {
  return join(backupsDir(home), PRE_UPDATE_DIR);
}

/**
 * Copies every database and `config.json` into a new snapshot folder (0700, files 0600) and
 * returns its path. The folder is built under a temporary name and renamed when complete, so a
 * snapshot that exists is a whole one. Throws if anything could not be copied.
 */
export async function createSnapshot(req: SnapshotRequest): Promise<string> {
  const at = (req.now ?? (() => new Date()))();
  const root = preUpdateDir(req.home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(backupsDir(req.home), 0o700);
  chmodSync(root, 0o700);
  const name = dirName(req.from, req.to, at);
  const temp = join(root, `.partial-${name}`);
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(join(temp, "files"), { recursive: true, mode: 0o700 });
  try {
    const entries: SnapshotEntry[] = [];
    const sources: { rel: string; abs: string; outside: boolean }[] = [];
    const seen = new Set<string>();
    const add = (given: string): void => {
      const abs = resolve(given);
      if (seen.has(abs) || !existsSync(abs)) return;
      seen.add(abs);
      const rel = relative(req.home, abs);
      const outside = rel.startsWith("..") || isAbsolute(rel);
      sources.push({ rel: outside ? abs : rel.split(sep).join("/"), abs, outside });
    };
    add(req.dbPath);
    for (const rel of findDatabases(req.home)) add(join(req.home, rel));
    for (const source of sources) {
      const stored = source.outside
        ? join(
            "files",
            "_external",
            `${createHash("sha256").update(source.abs).digest("hex").slice(0, 12)}-${source.abs.split(sep).at(-1)}`,
          )
        : join("files", source.rel);
      const dest = join(temp, stored);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      const plain = isPlainSqlite(source.abs);
      if (plain) {
        await backupDatabaseFile(source.abs, dest);
      } else {
        copyFileSync(source.abs, dest);
        for (const suffix of SIDECARS) {
          if (existsSync(source.abs + suffix)) copyFileSync(source.abs + suffix, dest + suffix);
        }
      }
      chmodSync(dest, 0o600);
      entries.push({
        rel: source.rel,
        kind: plain ? "sqlite" : "file",
        bytes: statSync(dest).size,
        sha256: sha256(dest),
        ...(source.outside ? { abs: source.abs } : {}),
        stored: stored.split(sep).join("/"),
      });
    }
    const config = join(req.home, "config.json");
    if (existsSync(config)) {
      const dest = join(temp, "files", "config.json");
      copyFileSync(config, dest);
      chmodSync(dest, 0o600);
      entries.push({
        rel: "config.json",
        kind: "file",
        bytes: statSync(dest).size,
        sha256: sha256(dest),
        stored: "files/config.json",
      });
    }
    const manifest: SnapshotManifest = {
      format: "psyche-pre-update",
      version: 1,
      createdAt: at.toISOString(),
      from: req.from,
      to: req.to,
      ...(req.build === undefined ? {} : { build: req.build }),
      pending: req.pending,
      entries,
    };
    writeFileSync(join(temp, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    const final = join(root, name);
    rmSync(final, { recursive: true, force: true });
    renameSync(temp, final);
    return final;
  } catch (err) {
    rmSync(temp, { recursive: true, force: true });
    throw err;
  }
}

/** The manifest of a snapshot folder, or undefined when it is not a whole one. */
export function readSnapshot(dir: string): SnapshotManifest | undefined {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")) as SnapshotManifest;
    return m.format === "psyche-pre-update" && m.version === 1 && Array.isArray(m.entries)
      ? m
      : undefined;
  } catch {
    return undefined;
  }
}

/** Snapshot folders, newest first. */
export function listSnapshots(home: string): { dir: string; manifest: SnapshotManifest }[] {
  const root = preUpdateDir(home);
  if (!existsSync(root)) return [];
  const out: { dir: string; manifest: SnapshotManifest }[] = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith(".")) continue;
    const manifest = readSnapshot(join(root, name));
    if (manifest !== undefined) out.push({ dir: join(root, name), manifest });
  }
  return out.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
}

/** Deletes all but the newest `keep` snapshots (and any half-made one); returns what it removed. */
export function pruneSnapshots(home: string, keep: number = DEFAULT_KEEP): string[] {
  const root = preUpdateDir(home);
  if (!existsSync(root)) return [];
  for (const name of readdirSync(root)) {
    if (name.startsWith(".partial-")) rmSync(join(root, name), { recursive: true, force: true });
  }
  const removed: string[] = [];
  for (const old of listSnapshots(home).slice(Math.max(1, keep))) {
    rmSync(old.dir, { recursive: true, force: true });
    removed.push(old.dir);
  }
  return removed;
}

/**
 * Puts a snapshot back: each database (and its stale `-wal`/`-shm`) is replaced by the copy, and
 * `config.json` is restored. The Gateway must not have the files open. Only paths inside `home`
 * are written, plus the absolute ones in `allowAbsolute`; a manifest cannot point elsewhere.
 * Every copy is checked against its recorded checksum first, so a damaged snapshot changes nothing.
 */
export function restoreSnapshot(
  dir: string,
  home: string,
  opts: { allowAbsolute?: readonly string[] } = {},
): SnapshotManifest {
  const manifest = readSnapshot(dir);
  if (manifest === undefined) throw new PsycheError("not_found", `${dir} is not a snapshot`);
  const plan = manifest.entries.map((e) => {
    const from = join(dir, e.stored);
    const target = e.abs ?? join(home, e.rel);
    const inside = !relative(home, target).startsWith("..") && !isAbsolute(relative(home, target));
    if (e.abs !== undefined ? !opts.allowAbsolute?.includes(e.abs) : !inside)
      throw new PsycheError("forbidden", `the snapshot names a path outside ${home}: ${e.rel}`);
    if (!existsSync(from) || sha256(from) !== e.sha256)
      throw new PsycheError("internal", `the snapshot copy of ${e.rel} is missing or damaged`);
    return { from, target, kind: e.kind };
  });
  for (const { from, target, kind } of plan) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    for (const suffix of SIDECARS) rmSync(target + suffix, { force: true });
    // Copy beside, then rename: a crash leaves the old file or the new one, never half of one.
    const temp = `${target}.restoring`;
    copyFileSync(from, temp);
    chmodSync(temp, 0o600);
    renameSync(temp, target);
    if (kind === "file") {
      for (const suffix of SIDECARS) {
        if (existsSync(from + suffix)) copyFileSync(from + suffix, target + suffix);
      }
    }
  }
  return manifest;
}

// --- the boot step --------------------------------------------------------------------------

export interface UpdateFailure {
  build: string;
  from: string;
  to: string;
  migration: string | null;
  at: string;
  snapshot: string;
  /** What the owner is told (the desktop's splash shows it when the Gateway will not start). */
  message: string;
}

export function readUpdateFailure(home: string): UpdateFailure | undefined {
  try {
    return JSON.parse(readFileSync(join(home, UPDATE_FAILED_FILE), "utf8")) as UpdateFailure;
  } catch {
    return undefined;
  }
}

/** What the owner is told. Plain words; the details stay in the log and `run/update-failed.json`. */
export function updateFailedMessage(to: string, restored: boolean): string {
  return restored
    ? `Psyche ${to} couldn't update your data, so it put everything back the way it was and did not start. Nothing was lost. Install the previous version of Psyche to carry on, or wait for the next update.`
    : `Psyche ${to} couldn't update your data and could not put it back automatically. Your data from before the update is in backups/pre-update inside Psyche's data folder. Please don't open Psyche again until you have restored it.`;
}

export interface OpenWithSnapshotOptions {
  home: string;
  dbPath: string;
  /** The version and build of the code that is about to migrate. */
  version: string;
  build: string;
  /** How many snapshots to keep (default 3). */
  keep?: number;
  now?: () => Date;
  logger?: Logger;
  /** Passed to `openDb` (the clock for row timestamps, a migrations folder in tests). */
  open?: OpenDbOptions;
  /** Test hook for the database opener. */
  opener?: (path: string, opts?: OpenDbOptions) => PsycheDb;
}

function lastBoot(home: string): { version: string; build?: string } | undefined {
  try {
    const v = JSON.parse(readFileSync(join(home, LAST_BOOT_FILE), "utf8")) as {
      version?: unknown;
      build?: unknown;
    };
    return typeof v.version === "string"
      ? { version: v.version, ...(typeof v.build === "string" ? { build: v.build } : {}) }
      : undefined;
  } catch {
    return undefined;
  }
}

function recordBoot(home: string, version: string, build: string, at: Date): void {
  const prev = lastBoot(home);
  if (prev?.version === version && prev.build === build) return;
  try {
    mkdirSync(join(home, "state"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, LAST_BOOT_FILE),
      `${JSON.stringify({ version, build, at: at.toISOString() })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Only the next snapshot's name depends on it.
  }
}

const LOCKED = /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i;

/**
 * Opens the Gateway's database, migrating it, with the safety net: with migrations pending the
 * data is snapshotted first; if they fail it is restored and the Gateway refuses to start. With
 * nothing pending this is just `openDb`. `:memory:` databases skip all of it.
 */
export async function openDbWithSnapshot(opts: OpenWithSnapshotOptions): Promise<PsycheDb> {
  const open = opts.opener ?? openDb;
  const migrationsDir = opts.open?.migrationsDir;
  const now = opts.now ?? (() => new Date());
  const pending = pendingMigrationIds(opts.dbPath, migrationsDir ?? undefined);
  if (opts.dbPath === ":memory:" || pending.length === 0) {
    const db = open(opts.dbPath, opts.open);
    if (opts.dbPath !== ":memory:") {
      rmSync(join(opts.home, UPDATE_FAILED_FILE), { force: true });
      recordBoot(opts.home, opts.version, opts.build, now());
    }
    return db;
  }

  // The same build failed on this data last time and was put back: don't churn snapshots by
  // trying again every few seconds (launchd restarts a Gateway that exits). A newer build tries.
  const failed = readUpdateFailure(opts.home);
  if (failed !== undefined && failed.build === opts.build && opts.build !== "dev") {
    throw new PsycheError("unavailable", updateFailedMessage(opts.version, true), {
      details: { reason: "update_failed", migration: failed.migration },
    });
  }

  const from = lastBoot(opts.home)?.version ?? "unknown";
  let snapshot: string;
  try {
    snapshot = await createSnapshot({
      home: opts.home,
      dbPath: opts.dbPath,
      from,
      to: opts.version,
      build: opts.build,
      pending,
      now,
    });
  } catch (err) {
    // Migrating without a way back is the risk this exists to remove: stop, and say why.
    opts.logger?.log("error", "pre-update snapshot failed", {
      code: PsycheError.from(err).code,
      pending: pending.length,
    });
    throw new PsycheError(
      "unavailable",
      `Psyche ${opts.version} needs to update your data, but couldn't make a safety copy first (is the disk full?), so it did not start. Nothing was changed.`,
      { details: { reason: "snapshot_failed" }, cause: err },
    );
  }
  opts.logger?.log("info", "pre-update snapshot made", {
    from,
    to: opts.version,
    pending: pending.length,
  });
  pruneSnapshots(opts.home, opts.keep ?? DEFAULT_KEEP);

  try {
    const db = open(opts.dbPath, opts.open);
    rmSync(join(opts.home, UPDATE_FAILED_FILE), { force: true });
    recordBoot(opts.home, opts.version, opts.build, now());
    return db;
  } catch (err) {
    // Another process holding the database is not a failed migration; nothing to undo.
    if (!(err instanceof MigrationError) || LOCKED.test(err.message)) throw err;
    let restored = false;
    try {
      restoreSnapshot(snapshot, opts.home, { allowAbsolute: [opts.dbPath] });
      restored = true;
    } catch (restoreErr) {
      opts.logger?.log("error", "pre-update restore failed", {
        code: PsycheError.from(restoreErr).code,
      });
    }
    const message = updateFailedMessage(opts.version, restored);
    const failure: UpdateFailure = {
      message,
      build: opts.build,
      from,
      to: opts.version,
      migration: err.migration ?? null,
      at: now().toISOString(),
      snapshot,
    };
    try {
      mkdirSync(join(opts.home, "run"), { recursive: true, mode: 0o700 });
      writeFileSync(join(opts.home, UPDATE_FAILED_FILE), `${JSON.stringify(failure, null, 2)}\n`, {
        mode: 0o600,
      });
    } catch {
      // The refusal below still stands.
    }
    opts.logger?.log("error", "migration failed; data restored", {
      migration: err.migration ?? null,
      restored,
    });
    throw new PsycheError("unavailable", message, {
      details: { reason: "update_failed", migration: err.migration ?? null, restored },
      cause: err,
    });
  }
}

/** `PSYCHE_PRE_UPDATE_KEEP`: how many pre-update snapshots to keep (1 to 20, default 3). */
export function keepFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PSYCHE_PRE_UPDATE_KEEP);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : DEFAULT_KEEP;
}

/**
 * The Gateway's own database, opened the safe way: pending migrations are snapshotted first and
 * undone if they fail (`openDbWithSnapshot`), with this build's version and the default retention
 * (`PSYCHE_PRE_UPDATE_KEEP`).
 */
export function openGatewayDb(
  config: { home: string; dbPath: string },
  now: () => string,
  logger?: Logger,
): Promise<PsycheDb> {
  const build = serverBuild();
  return openDbWithSnapshot({
    home: config.home,
    dbPath: config.dbPath,
    version: build.version,
    build: build.build,
    keep: keepFromEnv(),
    open: { now },
    ...(logger === undefined ? {} : { logger }),
  });
}
