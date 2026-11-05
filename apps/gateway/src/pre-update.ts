import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
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
  probeMigrations,
} from "@psyche/db";
import { PsycheError } from "@psyche/protocol";
import { serverBuild } from "./build-info.ts";
import type { Logger } from "./log.ts";

/**
 * The snapshot in front of pending migrations (updates design §2.7, gap G2).
 *
 * Migrations run forward-only at boot, and nothing could undo one. So when the database has
 * migrations the new build will apply (or cannot be read, which is treated as "maybe"), every
 * database and `config.json` are copied first into
 * `$PSYCHE_HOME/backups/pre-update/<from>-to-<to>-<time>/`. If a migration then fails, the
 * snapshot is put back and the Gateway refuses to start with a plain message, instead of running
 * on a half-migrated database.
 *
 * - SQLite files are copied with SQLite's online backup API (consistent under WAL). A file that
 *   is not plain SQLite (the memory store is encrypted) is copied as is, with its `-wal` and
 *   `-journal` (checksummed; never the rebuildable `-shm`), which is safe because nothing has
 *   opened it yet at this point of the boot. The small key files that open those stores are
 *   copied too (`EXTRA_FILES`).
 * - Everything is fsynced (files, then folders) before a migration starts and after a restore.
 * - A restore is crash-atomic: `run/restore-in-progress.json` names the snapshot before any file
 *   is touched, each file is placed through a temp file and a rename, and the next boot finishes
 *   a restore that was cut short before doing anything else.
 * - Retention (§2.7.4): the newest {@link DEFAULT_KEEP} are kept; an older one goes only after
 *   14 days, only after a successful boot, and never one newer than the last good boot. A boot
 *   that never succeeded reuses its snapshot instead of copying half-migrated data again.
 * - Not copied: `workspace/`, `library/`, `browser/` (large, never migrated), `state/teach` (the
 *   owner's recordings) and `security/` (revocations must replay after a restore).
 *
 * Not encrypted beyond what the files already are: it sits beside the live files, with the same
 * exposure. It is not `psyche backup`, which stays the portable, encrypted copy.
 */

export const PRE_UPDATE_DIR = "pre-update";
export const MANIFEST_FILE = "manifest.json";
/** Written beside the Gateway's other run files when a migration failed and was undone. */
export const UPDATE_FAILED_FILE = join("run", "update-failed.json");
/** Names the snapshot being put back; present only while a restore is under way. */
export const RESTORE_MARKER_FILE = join("run", "restore-in-progress.json");
/** Present while a snapshot or migrations are running; the desktop waits longer meanwhile. */
export const UPDATE_PROGRESS_FILE = join("run", "update-progress.json");
/** Where the Gateway remembers which build last opened this data, and the last good snapshot. */
export const LAST_BOOT_FILE = join("state", "last-boot.json");
export const DEFAULT_KEEP = 2;
/** Design §2.7.4: an older snapshot is deleted only after this long. */
export const PRUNE_AFTER_MS = 14 * 24 * 3_600_000;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
/** `-shm` is a rebuildable index and is never copied. */
const SIDECARS = ["-wal", "-journal"] as const;
const ALL_SIDECARS = ["-wal", "-shm", "-journal"] as const;
const DB_NAME = /\.(sqlite3?|db)$/;
/** Folders searched for databases; `state/teach` holds the owner's recordings and is skipped. */
const DB_ROOTS = ["state", "vault"] as const;
const SKIP_DIRS = new Set([join("state", "teach")]);
/** The small files that open the stores: without them a restored database cannot be read. */
export const EXTRA_FILES = [
  "vault/slots.json",
  "state/memory.key.json",
  "state/memory.key.escrow.json",
  "state/search.key.json",
] as const;

export interface SnapshotSidecar {
  suffix: (typeof SIDECARS)[number];
  bytes: number;
  sha256: string;
}

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
  /** Copied beside a `file` entry (an encrypted store's write-ahead log). */
  sidecars?: SnapshotSidecar[];
}

export interface SnapshotManifest {
  format: "psyche-pre-update";
  version: 1;
  /** Monotonic: the newest snapshot has the highest. Retention sorts by this, not by the clock. */
  seq: number;
  createdAt: string;
  from: string;
  to: string;
  build?: string;
  /** The migration ids this update was about to apply (empty when the probe could not tell). */
  pending: string[];
  /** Why the migrations could not be listed, when they could not. */
  probe?: string;
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
  probe?: string;
  now?: () => Date;
}

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

// --- durable file helpers -------------------------------------------------------------------

function fsyncPath(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Some filesystems refuse to sync a directory; the rename still happened.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fsyncTree(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) fsyncTree(p);
    else fsyncPath(p);
  }
  fsyncPath(dir);
}

/** Copies `from` to `target` through a temp file and a rename, 0600, synced. */
function placeFile(from: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.restoring`;
  copyFileSync(from, temp);
  chmodSync(temp, 0o600);
  fsyncPath(temp);
  renameSync(temp, target);
  fsyncPath(dirname(target));
}

function writeJsonDurable(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fsyncPath(temp);
  renameSync(temp, path);
  fsyncPath(dirname(path));
}

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

function safeName(v: string): string {
  return v.replace(/[^A-Za-z0-9._+-]/g, "_").slice(0, 40) || "unknown";
}

export function preUpdateDir(home: string): string {
  return join(backupsDir(home), PRE_UPDATE_DIR);
}

function nextSeq(home: string): number {
  return listSnapshots(home).reduce((max, s) => Math.max(max, s.manifest.seq), 0) + 1;
}

/**
 * Copies every database, the key files that open them, and `config.json` into a new snapshot
 * folder (0700, files 0600), syncs it, and returns its path. The folder is built under a
 * temporary name and renamed when complete, so a snapshot that exists is a whole one. Throws if
 * anything could not be copied.
 */
export async function createSnapshot(req: SnapshotRequest): Promise<string> {
  const at = (req.now ?? (() => new Date()))();
  const root = preUpdateDir(req.home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(backupsDir(req.home), 0o700);
  chmodSync(root, 0o700);
  const seq = nextSeq(req.home);
  let name = `${safeName(req.from)}-to-${safeName(req.to)}-${at.toISOString().replace(/[:.]/g, "-")}`;
  if (existsSync(join(root, name))) name = `${name}-${seq}`;
  const temp = join(root, `.partial-${name}`);
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(join(temp, "files"), { recursive: true, mode: 0o700 });
  try {
    const entries: SnapshotEntry[] = [];
    const sources: { rel: string; abs: string; outside: boolean; forceFile: boolean }[] = [];
    const seen = new Set<string>();
    const add = (given: string, forceFile = false): void => {
      const abs = resolve(given);
      if (seen.has(abs) || !existsSync(abs)) return;
      seen.add(abs);
      const rel = relative(req.home, abs);
      const outside = rel.startsWith("..") || isAbsolute(rel);
      sources.push({ rel: outside ? abs : rel.split(sep).join("/"), abs, outside, forceFile });
    };
    add(req.dbPath);
    for (const rel of findDatabases(req.home)) add(join(req.home, rel));
    for (const rel of EXTRA_FILES) add(join(req.home, rel), true);
    add(join(req.home, "config.json"), true);
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
      const plain = !source.forceFile && isPlainSqlite(source.abs);
      const sidecars: SnapshotSidecar[] = [];
      if (plain) {
        await backupDatabaseFile(source.abs, dest);
      } else {
        copyFileSync(source.abs, dest);
        for (const suffix of SIDECARS) {
          if (!existsSync(source.abs + suffix)) continue;
          copyFileSync(source.abs + suffix, dest + suffix);
          chmodSync(dest + suffix, 0o600);
          sidecars.push({
            suffix,
            bytes: statSync(dest + suffix).size,
            sha256: sha256(dest + suffix),
          });
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
        ...(sidecars.length > 0 ? { sidecars } : {}),
      });
    }
    const manifest: SnapshotManifest = {
      format: "psyche-pre-update",
      version: 1,
      seq,
      createdAt: at.toISOString(),
      from: req.from,
      to: req.to,
      ...(req.build === undefined ? {} : { build: req.build }),
      pending: req.pending,
      ...(req.probe === undefined ? {} : { probe: req.probe }),
      entries,
    };
    writeFileSync(join(temp, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    // On disk before a migration may start, files first and then the folders that name them.
    fsyncTree(temp);
    const final = join(root, name);
    renameSync(temp, final);
    fsyncPath(root);
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
      ? { ...m, seq: typeof m.seq === "number" ? m.seq : 0 }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Snapshot folders, newest first by sequence (never by the clock, which can move back). */
export function listSnapshots(home: string): { dir: string; manifest: SnapshotManifest }[] {
  const root = preUpdateDir(home);
  if (!existsSync(root)) return [];
  const out: { dir: string; manifest: SnapshotManifest }[] = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith(".")) continue;
    const manifest = readSnapshot(join(root, name));
    if (manifest !== undefined) out.push({ dir: join(root, name), manifest });
  }
  return out.sort(
    (a, b) => b.manifest.seq - a.manifest.seq || (a.dir < b.dir ? 1 : a.dir > b.dir ? -1 : 0),
  );
}

export interface PruneOptions {
  keep?: number;
  now?: Date;
  /** Older than this to be deleted (default 14 days). */
  minAgeMs?: number;
  /** The highest sequence of a boot that succeeded: nothing above it is ever deleted. */
  goodSeq?: number;
}

/**
 * Deletes half-made folders and snapshots that are beyond the newest `keep`, older than
 * `minAgeMs`, and not newer than the last good boot. Call only after a successful boot.
 */
export function pruneSnapshots(home: string, opts: PruneOptions = {}): string[] {
  const root = preUpdateDir(home);
  if (!existsSync(root)) return [];
  for (const name of readdirSync(root)) {
    if (name.startsWith(".partial-")) rmSync(join(root, name), { recursive: true, force: true });
  }
  const keep = Math.max(1, opts.keep ?? DEFAULT_KEEP);
  const minAge = opts.minAgeMs ?? PRUNE_AFTER_MS;
  const nowMs = (opts.now ?? new Date()).getTime();
  const removed: string[] = [];
  listSnapshots(home).forEach((snap, i) => {
    if (i < keep) return;
    if (opts.goodSeq !== undefined && snap.manifest.seq > opts.goodSeq) return;
    const age = nowMs - Date.parse(snap.manifest.createdAt);
    if (Number.isFinite(age) && age < minAge) return;
    rmSync(snap.dir, { recursive: true, force: true });
    removed.push(snap.dir);
  });
  return removed;
}

/** Removes every pre-update snapshot (forget-everything, uninstall with data). */
export function purgePreUpdateSnapshots(home: string): void {
  rmSync(preUpdateDir(home), { recursive: true, force: true });
}

/**
 * Puts a snapshot back. Every copy (and sidecar) is checked against its recorded checksum first,
 * so a damaged snapshot changes nothing. Then, per file: stale `-wal`/`-shm`/`-journal` go, and
 * the copy is placed through a temp file and a rename. Only paths inside `home` are written,
 * plus the absolute ones in `allowAbsolute` (compared after resolving both sides); a manifest
 * cannot point elsewhere. The Gateway must not have the files open. Use
 * {@link restoreWithMarker} when a crash in the middle must be recoverable.
 */
export function restoreSnapshot(
  dir: string,
  home: string,
  opts: { allowAbsolute?: readonly string[] } = {},
): SnapshotManifest {
  const planned = planRestore(dir, home, opts);
  applyRestore(planned);
  return planned.manifest;
}

interface RestorePlan {
  manifest: SnapshotManifest;
  steps: { from: string; target: string; entry: SnapshotEntry }[];
}

/** Checks a snapshot and decides where each file goes; touches nothing. */
function planRestore(
  dir: string,
  home: string,
  opts: { allowAbsolute?: readonly string[] },
): RestorePlan {
  const manifest = readSnapshot(dir);
  if (manifest === undefined) throw new PsycheError("not_found", `${dir} is not a snapshot`);
  const allowed = (opts.allowAbsolute ?? []).map((p) => resolve(p));
  const plan = manifest.entries.map((e) => {
    const from = join(dir, e.stored);
    const target = e.abs === undefined ? resolve(home, e.rel) : resolve(e.abs);
    const rel = relative(resolve(home), target);
    const inside = !rel.startsWith("..") && !isAbsolute(rel);
    if (e.abs !== undefined ? !allowed.includes(target) : !inside)
      throw new PsycheError("forbidden", `the snapshot names a path outside ${home}: ${e.rel}`);
    if (!existsSync(from) || sha256(from) !== e.sha256)
      throw new PsycheError("internal", `the snapshot copy of ${e.rel} is missing or damaged`);
    for (const s of e.sidecars ?? []) {
      if (!existsSync(from + s.suffix) || sha256(from + s.suffix) !== s.sha256)
        throw new PsycheError("internal", `the snapshot copy of ${e.rel}${s.suffix} is damaged`);
    }
    return { from, target, entry: e };
  });
  return { manifest, steps: plan };
}

function applyRestore(plan: RestorePlan): void {
  for (const { from, target, entry } of plan.steps) {
    for (const suffix of ALL_SIDECARS) rmSync(target + suffix, { force: true });
    placeFile(from, target);
    for (const s of entry.sidecars ?? []) placeFile(from + s.suffix, target + s.suffix);
  }
}

interface RestoreMarker {
  snapshot: string;
  at: string;
  allowAbsolute: string[];
}

/**
 * {@link restoreSnapshot}, preceded by a durable note naming the snapshot, so that a crash or
 * power loss half way is finished by {@link finishPendingRestore} at the next boot.
 */
export function restoreWithMarker(
  dir: string,
  home: string,
  opts: { allowAbsolute?: readonly string[]; now?: () => Date } = {},
): SnapshotManifest {
  // A damaged or foreign snapshot is refused before anything is written, marker included.
  const planned = planRestore(dir, home, opts);
  const marker: RestoreMarker = {
    snapshot: dir,
    at: (opts.now ?? (() => new Date()))().toISOString(),
    allowAbsolute: [...(opts.allowAbsolute ?? [])],
  };
  writeJsonDurable(join(home, RESTORE_MARKER_FILE), marker);
  applyRestore(planned);
  rmSync(join(home, RESTORE_MARKER_FILE), { force: true });
  fsyncPath(join(home, "run"));
  return planned.manifest;
}

/** Finishes a restore that a crash cut short; returns whether there was one. */
export function finishPendingRestore(home: string, logger?: Logger): boolean {
  let marker: RestoreMarker;
  try {
    marker = JSON.parse(readFileSync(join(home, RESTORE_MARKER_FILE), "utf8")) as RestoreMarker;
  } catch {
    return false;
  }
  logger?.log("warn", "finishing an interrupted restore of the pre-update snapshot");
  try {
    restoreSnapshot(marker.snapshot, home, { allowAbsolute: marker.allowAbsolute });
  } catch (err) {
    throw new PsycheError(
      "unavailable",
      `Psyche was putting your data back after a failed update when it was interrupted, and could not finish (${PsycheError.from(err).message}). Your data from before the update is in backups/pre-update inside Psyche's data folder. Please don't open Psyche again until you have restored it.`,
      { details: { reason: "restore_interrupted" }, cause: err },
    );
  }
  rmSync(join(home, RESTORE_MARKER_FILE), { force: true });
  fsyncPath(join(home, "run"));
  return true;
}

// --- the boot step --------------------------------------------------------------------------

export interface UpdateFailure {
  build: string;
  /** What "the same failure" means: the build, or for a `dev` build version + pending migrations. */
  key: string;
  /** `deterministic`: the SQL or the data is at fault. `environment`: disk full, I/O, permissions. */
  kind: "deterministic" | "environment";
  attempts: number;
  /** ISO time before which this key is not tried again; null = until the note is removed. */
  retryAfter: string | null;
  from: string;
  to: string;
  migration: string | null;
  at: string;
  snapshot: string | null;
  restored: boolean;
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

/** The owner's "try again": removes the note so the next start attempts the update. */
export function clearUpdateFailure(home: string): boolean {
  const had = existsSync(join(home, UPDATE_FAILED_FILE));
  rmSync(join(home, UPDATE_FAILED_FILE), { force: true });
  return had;
}

/** What the owner is told. Plain words; the details stay in the log and `run/update-failed.json`. */
export function updateFailedMessage(to: string, restored: boolean): string {
  return restored
    ? `Psyche ${to} couldn't update your data, so it put everything back the way it was and did not start. Nothing was lost. Install the previous version of Psyche to carry on, or wait for the next update.`
    : `Psyche ${to} couldn't update your data and could not put it back automatically. Your data from before the update is in backups/pre-update inside Psyche's data folder. Please don't open Psyche again until you have restored it.`;
}

function snapshotFailedMessage(to: string): string {
  return `Psyche ${to} needs to update your data, but couldn't make a safety copy first (is the disk full?), so it did not start. Nothing was changed. Free some space and choose Try again.`;
}

/** Errors that come from the machine, not from the migration: worth trying again later. */
const ENVIRONMENT =
  /database or disk is full|disk I\/O error|readonly database|unable to open database|no space left|SQLITE_(FULL|IOERR|READONLY|CANTOPEN)|\bE(NOSPC|ACCES|ROFS|IO|MFILE)\b/i;
const LOCKED = /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i;
const BACKOFF_START_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const DEV_BACKOFF_MS = 5 * 60_000;

export interface OpenWithSnapshotOptions {
  home: string;
  dbPath: string;
  /** The version and build of the code that is about to migrate. */
  version: string;
  build: string;
  /** How many snapshots to keep (default 2). */
  keep?: number;
  /** Test hook: how old a snapshot must be to be deleted (default 14 days). */
  minPruneAgeMs?: number;
  now?: () => Date;
  logger?: Logger;
  /** Passed to `openDb` (the clock for row timestamps, a migrations folder in tests). */
  open?: OpenDbOptions;
  /** Test hook for the database opener. */
  opener?: (path: string, opts?: OpenDbOptions) => PsycheDb;
}

interface LastBoot {
  version: string;
  build?: string;
  /** The highest snapshot sequence at the last boot that succeeded. */
  goodSeq: number;
}

function lastBoot(home: string): LastBoot | undefined {
  try {
    const v = JSON.parse(readFileSync(join(home, LAST_BOOT_FILE), "utf8")) as {
      version?: unknown;
      build?: unknown;
      goodSeq?: unknown;
    };
    return typeof v.version === "string"
      ? {
          version: v.version,
          ...(typeof v.build === "string" ? { build: v.build } : {}),
          goodSeq: typeof v.goodSeq === "number" ? v.goodSeq : 0,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function recordBoot(home: string, version: string, build: string, at: Date): number {
  const goodSeq = listSnapshots(home).reduce((max, s) => Math.max(max, s.manifest.seq), 0);
  const prev = lastBoot(home);
  if (prev?.version === version && prev.build === build && prev.goodSeq === goodSeq) return goodSeq;
  try {
    writeJsonDurable(join(home, LAST_BOOT_FILE), {
      version,
      build,
      goodSeq,
      at: at.toISOString(),
    });
  } catch {
    // Only the next snapshot's name and retention depend on it.
  }
  return goodSeq;
}

function writeProgress(home: string, phase: "snapshot" | "migrating", build: string, at: Date) {
  try {
    writeJsonDurable(join(home, UPDATE_PROGRESS_FILE), { phase, build, at: at.toISOString() });
  } catch {
    // The splash just waits its usual time.
  }
}

/**
 * Opens the Gateway's database, migrating it, with the safety net: with migrations pending (or
 * not readable) the data is snapshotted first; if they fail it is restored and the Gateway
 * refuses to start. With nothing pending this is just `openDb`. `:memory:` databases skip all
 * of it.
 */
export async function openDbWithSnapshot(opts: OpenWithSnapshotOptions): Promise<PsycheDb> {
  const open = opts.opener ?? openDb;
  const now = opts.now ?? (() => new Date());
  const keep = opts.keep ?? DEFAULT_KEEP;
  if (opts.dbPath === ":memory:") return open(opts.dbPath, opts.open);

  finishPendingRestore(opts.home, opts.logger);
  const probe = probeMigrations(opts.dbPath, opts.open?.migrationsDir ?? undefined);
  const succeeded = (db: PsycheDb): PsycheDb => {
    rmSync(join(opts.home, UPDATE_FAILED_FILE), { force: true });
    rmSync(join(opts.home, UPDATE_PROGRESS_FILE), { force: true });
    const goodSeq = recordBoot(opts.home, opts.version, opts.build, now());
    // Only now, with a boot that worked, may older snapshots go.
    try {
      pruneSnapshots(opts.home, {
        keep,
        goodSeq,
        now: now(),
        ...(opts.minPruneAgeMs === undefined ? {} : { minAgeMs: opts.minPruneAgeMs }),
      });
    } catch {
      // Retention is housekeeping.
    }
    return db;
  };
  if (probe.state === "none") return succeeded(open(opts.dbPath, opts.open));

  const pending = probe.state === "pending" ? probe.ids : [];
  const probeNote = probe.state === "unknown" ? probe.reason : undefined;
  const key =
    opts.build === "dev"
      ? `dev:${opts.version}:${createHash("sha256")
          .update(pending.join(",") || "unknown")
          .digest("hex")
          .slice(0, 12)}`
      : opts.build;

  // The same failure last time, and not yet time to try again: don't churn snapshots by trying
  // every few seconds (launchd restarts a Gateway that exits). A newer build tries at once.
  const failed = readUpdateFailure(opts.home);
  if (failed !== undefined && failed.key === key) {
    const wait =
      failed.retryAfter === null ? Number.POSITIVE_INFINITY : Date.parse(failed.retryAfter);
    if (now().getTime() < wait) {
      throw new PsycheError("unavailable", failed.message, {
        details: {
          reason: "update_failed",
          migration: failed.migration,
          restored: failed.restored,
        },
      });
    }
  }
  const attempts = failed !== undefined && failed.key === key ? failed.attempts : 0;

  const from = lastBoot(opts.home)?.version ?? "unknown";
  const recordFailure = (
    f: Omit<UpdateFailure, "build" | "key" | "from" | "to" | "at" | "attempts" | "retryAfter">,
  ) => {
    const environment = f.kind === "environment";
    const backoff = environment
      ? Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** attempts)
      : opts.build === "dev"
        ? DEV_BACKOFF_MS
        : null;
    const note: UpdateFailure = {
      ...f,
      build: opts.build,
      key,
      from,
      to: opts.version,
      at: now().toISOString(),
      attempts: attempts + 1,
      retryAfter:
        backoff === null || !f.restored ? null : new Date(now().getTime() + backoff).toISOString(),
    };
    try {
      writeJsonDurable(join(opts.home, UPDATE_FAILED_FILE), note);
    } catch {
      // The refusal still stands.
    }
  };

  writeProgress(opts.home, "snapshot", opts.build, now());
  // A boot of this very build that never succeeded already has its snapshot: the data may be
  // half migrated now, so put that one back instead of copying the half-migrated files.
  const good = lastBoot(opts.home)?.goodSeq ?? 0;
  const reusable = listSnapshots(opts.home).find(
    (s) =>
      s.manifest.to === opts.version && s.manifest.build === opts.build && s.manifest.seq > good,
  );
  let snapshot: string;
  try {
    if (reusable !== undefined) {
      // A snapshot of data that could not be read at all is kept as it is: putting it back
      // would undo a repair the owner may have made since.
      if (reusable.manifest.probe === undefined)
        restoreWithMarker(reusable.dir, opts.home, { allowAbsolute: [opts.dbPath], now });
      snapshot = reusable.dir;
      opts.logger?.log("info", "pre-update snapshot reused", { to: opts.version });
    } else {
      snapshot = await createSnapshot({
        home: opts.home,
        dbPath: opts.dbPath,
        from,
        to: opts.version,
        build: opts.build,
        pending,
        ...(probeNote === undefined ? {} : { probe: probeNote }),
        now,
      });
      opts.logger?.log("info", "pre-update snapshot made", {
        from,
        to: opts.version,
        pending: pending.length,
      });
    }
  } catch (err) {
    // Migrating without a way back is the risk this exists to remove: stop, and say why.
    opts.logger?.log("error", "pre-update snapshot failed", {
      code: PsycheError.from(err).code,
      pending: pending.length,
    });
    rmSync(join(opts.home, UPDATE_PROGRESS_FILE), { force: true });
    const message = snapshotFailedMessage(opts.version);
    recordFailure({
      kind: "environment",
      migration: null,
      snapshot: null,
      restored: true,
      message,
    });
    throw new PsycheError("unavailable", message, {
      details: { reason: "snapshot_failed" },
      cause: err,
    });
  }

  writeProgress(opts.home, "migrating", opts.build, now());
  try {
    return succeeded(open(opts.dbPath, opts.open));
  } catch (err) {
    rmSync(join(opts.home, UPDATE_PROGRESS_FILE), { force: true });
    // Another process holding the database is not a failed migration; nothing to undo.
    if (!(err instanceof MigrationError) || LOCKED.test(err.message)) throw err;
    let restored = false;
    try {
      restoreWithMarker(snapshot, opts.home, { allowAbsolute: [opts.dbPath], now });
      restored = true;
    } catch (restoreErr) {
      opts.logger?.log("error", "pre-update restore failed", {
        code: PsycheError.from(restoreErr).code,
      });
    }
    const message = updateFailedMessage(opts.version, restored);
    recordFailure({
      kind: ENVIRONMENT.test(err.message) ? "environment" : "deterministic",
      migration: err.migration ?? null,
      snapshot,
      restored,
      message,
    });
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

/** `PSYCHE_PRE_UPDATE_KEEP`: how many pre-update snapshots to keep (1 to 20, default 2). */
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
