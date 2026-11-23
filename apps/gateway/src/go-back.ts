import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PsycheError } from "@psyche/protocol";
import type { Logger } from "./log.ts";
import {
  ALL_SIDECARS,
  displacedPath,
  fsyncPath,
  isInside,
  liveFingerprint,
  planRestore,
  preUpdateDir,
  RESTORE_MARKER_FILE,
  restoreWithMarker,
  sha256File,
  UPDATE_FAILED_FILE,
  type UpdateFailure,
  writeJsonDurable,
} from "./pre-update.ts";

/**
 * "Go back to <version>" on Linux (updates design §2.5, Linux design §"Rollback"): the data half.
 *
 * The desktop stops the Gateway, calls `restoreForGoBack`, swaps the app, and calls
 * `commitGoBack`. If the swap does not happen it calls `undoGoBack`, which puts back exactly what
 * the restore changed, so a go-back that does not happen leaves the data as it was.
 *
 * Both halves are one durable pair. Before the restore touches anything, `run/go-back.json`
 * records, for every file the restore can change (each database, its `-wal`/`-shm`/`-journal`,
 * `config.json` and the key files): its SHA-256 now, or "absent". The restore runs through the
 * usual marker flow with its own displaced folder, so each file it replaces is MOVED there, never
 * overwritten. Undo then needs no guessing: every path ends up byte for byte what it was. A file
 * the restore created is removed, a file it replaced is moved back, and any other content found
 * in the way is moved aside (`<displaced>-undone`), never deleted. Undo checks every path
 * afterwards and throws, leaving the journal, if even one is not back; it is safe to run twice.
 *
 * A crash anywhere in between is settled by {@link finishPendingGoBack} at the next Gateway
 * start, before anything opens the data: if the code that is starting is the build that was
 * being left (so the swap did not happen) and the restored data is untouched, the restore is
 * undone; otherwise the go-back is taken as done and the journal is dropped, with the newer data
 * left in the displaced folder for the usual 30 days.
 */

export const GO_BACK_JOURNAL_FILE = join("run", "go-back.json");

interface JournalPath {
  /** Home-relative path (forward slashes), or ... */
  rel?: string;
  /** ... an absolute path outside the data folder (a `PSYCHE_DB` override). */
  abs?: string;
  /** SHA-256 before the restore; null when there was no file. */
  before: string | null;
  /** SHA-256 the restore leaves there; null when it leaves nothing. */
  expect: string | null;
}

interface GoBackJournal {
  format: "psyche-go-back";
  version: 1;
  /** The version being gone back to (the snapshot was taken when updating from it). */
  toVersion: string;
  /** Absolute path of the snapshot folder that was restored. */
  snapshot: string;
  /** Where the restore moves what it replaces. */
  displaceTo: string;
  /** The build that was running when the go-back began: the one being left. */
  leavingBuild: string;
  leavingVersion: string;
  at: string;
  /** `restoring` until the restore has returned; then `restored`. */
  phase: "restoring" | "restored";
  /** The main database's fingerprint right after the restore. */
  liveFingerprint?: string;
  paths: JournalPath[];
}

export interface GoBackOptions {
  /** The main database's path: the one absolute path a snapshot may restore (`PSYCHE_DB`). */
  dbPath: string;
  logger?: Logger;
  now?: () => Date;
}

function journalFile(home: string): string {
  return join(home, GO_BACK_JOURNAL_FILE);
}

function readJournal(home: string): GoBackJournal | undefined {
  let text: string;
  try {
    text = readFileSync(journalFile(home), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new PsycheError("unavailable", `the go-back note cannot be read: ${errorText(err)}`);
  }
  try {
    const j = JSON.parse(text) as GoBackJournal;
    if (
      j.format !== "psyche-go-back" ||
      j.version !== 1 ||
      typeof j.toVersion !== "string" ||
      typeof j.snapshot !== "string" ||
      typeof j.displaceTo !== "string" ||
      typeof j.leavingBuild !== "string" ||
      (j.phase !== "restoring" && j.phase !== "restored") ||
      !Array.isArray(j.paths)
    )
      throw new Error("not a go-back note");
    return j;
  } catch {
    throw new PsycheError("unavailable", "the go-back note is damaged");
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The SHA-256 of a regular file, or null when there is none. Anything else is refused. */
function shaOrNull(file: string): string | null {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!st.isFile()) throw new PsycheError("forbidden", `${file} is not a plain file`);
  return sha256File(file);
}

function pathOf(home: string, p: JournalPath, allowed: readonly string[]): string {
  if (p.abs !== undefined) {
    const abs = resolve(p.abs);
    if (!allowed.includes(abs) && !allowed.some((a) => abs.startsWith(`${a}-`)))
      throw new PsycheError("forbidden", `the go-back note names a path outside ${home}: ${p.abs}`);
    return abs;
  }
  if (typeof p.rel !== "string")
    throw new PsycheError("forbidden", "the go-back note has a file with no path");
  const file = resolve(home, p.rel);
  const rel = relative(resolve(home), file);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    throw new PsycheError("forbidden", `the go-back note names a path outside ${home}: ${p.rel}`);
  return file;
}

/** Rename, or copy-then-delete when the folders are on different filesystems. */
function moveFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    const temp = `${to}.undoing`;
    copyFileSync(from, temp);
    chmodSync(temp, 0o600);
    fsyncPath(temp);
    renameSync(temp, to);
    rmSync(from, { force: true });
  }
  fsyncPath(dirname(to));
}

/** Writes the journal for `dir`, runs the restore, and records that it finished. */
export function restoreForGoBack(
  dir: string,
  home: string,
  toVersion: string,
  opts: GoBackOptions & { build: string; version: string },
): void {
  const now = opts.now ?? (() => new Date());
  if (existsSync(journalFile(home))) {
    throw new PsycheError(
      "unavailable",
      "an earlier go back did not finish. Start Psyche once so it can settle it, then try again",
    );
  }
  const allowAbsolute = [opts.dbPath];
  const planned = planRestore(dir, home, { allowAbsolute });
  const paths: JournalPath[] = [];
  for (const { target, entry } of planned.steps) {
    for (const suffix of ["", ...ALL_SIDECARS]) {
      const file = target + suffix;
      const expect =
        suffix === ""
          ? entry.sha256
          : (entry.sidecars?.find((s) => s.suffix === suffix)?.sha256 ?? null);
      const where =
        entry.abs === undefined
          ? { rel: relative(resolve(home), file).split("\\").join("/") }
          : { abs: file };
      paths.push({ ...where, before: shaOrNull(file), expect });
    }
  }
  const displaceTo = join(
    preUpdateDir(home),
    `.displaced-goback-${basename(dir)}-${now().getTime().toString(36)}`,
  );
  const journal: GoBackJournal = {
    format: "psyche-go-back",
    version: 1,
    toVersion,
    snapshot: resolve(dir),
    displaceTo,
    leavingBuild: opts.build,
    leavingVersion: opts.version,
    at: now().toISOString(),
    phase: "restoring",
    paths,
  };
  writeJsonDurable(journalFile(home), journal);
  try {
    restoreWithMarker(dir, home, {
      allowAbsolute,
      displaceTo,
      now,
      ...(opts.logger === undefined ? {} : { logger: opts.logger }),
    });
    const fp = liveFingerprint(opts.dbPath);
    writeJsonDurable(journalFile(home), {
      ...journal,
      phase: "restored",
      ...(fp === undefined ? {} : { liveFingerprint: fp }),
    } satisfies GoBackJournal);
  } catch (err) {
    // A restore that stopped halfway must not stay half done: the caller does not call undo for
    // a restore that threw.
    try {
      undoGoBack(home, toVersion, opts);
    } catch (undoErr) {
      throw new PsycheError(
        "internal",
        `${errorText(err)}; and what was changed could not be put back (${errorText(undoErr)}). Your data from before is in ${relative(home, displaceTo)}`,
      );
    }
    throw err;
  }
}

/** The go-back is done: forget the journal, keep the displaced data (it is pruned after 30 days). */
export function commitGoBack(home: string): boolean {
  const had = existsSync(journalFile(home));
  rmSync(journalFile(home), { force: true });
  fsyncPath(join(home, "run"));
  return had;
}

/** Puts one file back to what it was before the restore; throws when it cannot. */
function undoPath(
  home: string,
  file: string,
  p: JournalPath,
  displaceTo: string,
  asideDir: string,
): void {
  const moveAside = () => {
    let dest = displacedPath(home, file, asideDir);
    if (existsSync(dest)) dest = `${dest}.${Date.now().toString(36)}`;
    moveFile(file, dest);
  };
  const cur = shaOrNull(file);
  if (cur !== p.before) {
    if (p.before !== null) {
      const kept = displacedPath(home, file, displaceTo);
      const source = [kept, `${kept}.latest`].find(
        (c) => existsSync(c) && shaOrNull(c) === p.before,
      );
      if (source === undefined)
        throw new PsycheError(
          "internal",
          `the original of ${relative(home, file) || file} is not in ${basename(displaceTo)}`,
        );
      // Whatever is there now is the snapshot's copy; anything else is somebody's: keep it.
      if (cur !== null && cur !== p.expect) moveAside();
      moveFile(source, file);
    } else if (cur !== null) {
      // The restore created this file where there was none.
      if (cur === p.expect) {
        rmSync(file, { force: true });
        fsyncPath(dirname(file));
      } else moveAside();
    }
  }
  const after = shaOrNull(file);
  if (after !== p.before)
    throw new PsycheError("internal", `${relative(home, file) || file} is not as it was`);
}

function pruneEmptyDirs(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(dir, name);
    if (lstatSync(p).isDirectory()) pruneEmptyDirs(p);
  }
  try {
    rmdirSync(dir);
  } catch {
    // Not empty: something is left that was not ours to delete.
  }
}

/**
 * Undoes {@link restoreForGoBack}: every file ends up as it was before it. Returns whether there
 * was anything to undo (a second call finds nothing and returns false). Throws, with the journal
 * kept, when any file could not be put back, so the caller never reports a half-undone folder as
 * done.
 */
export function undoGoBack(
  home: string,
  toVersion: string | undefined,
  opts: Pick<GoBackOptions, "dbPath" | "logger">,
): boolean {
  const journal = readJournal(home);
  if (journal === undefined) return false;
  if (toVersion !== undefined && journal.toVersion !== toVersion)
    throw new PsycheError(
      "unavailable",
      `a go back to ${journal.toVersion} is unfinished, not one to ${toVersion}`,
    );
  if (
    !isInside(preUpdateDir(home), journal.displaceTo) ||
    !isInside(preUpdateDir(home), journal.snapshot)
  )
    throw new PsycheError("forbidden", "the go-back note names a place outside the snapshots");
  const allowed = [resolve(opts.dbPath)];
  const files = journal.paths.map((p) => ({ p, file: pathOf(home, p, allowed) }));
  // The restore's own note must go first: otherwise the next start would "finish" the restore
  // over the data this puts back.
  const markerFile = join(home, RESTORE_MARKER_FILE);
  if (existsSync(markerFile)) {
    let snapshot: unknown;
    try {
      snapshot = (JSON.parse(readFileSync(markerFile, "utf8")) as { snapshot?: unknown }).snapshot;
    } catch {
      snapshot = undefined;
    }
    if (typeof snapshot !== "string" || resolve(snapshot) !== resolve(journal.snapshot))
      throw new PsycheError("unavailable", "another restore is pending: not undoing over it");
    rmSync(markerFile, { force: true });
    fsyncPath(join(home, "run"));
  }
  const asideDir = `${journal.displaceTo}-undone`;
  const failures: string[] = [];
  for (const { p, file } of files) {
    try {
      undoPath(home, file, p, journal.displaceTo, asideDir);
    } catch (err) {
      failures.push(errorText(err));
    }
  }
  if (failures.length > 0)
    throw new PsycheError(
      "internal",
      `${failures.length} file(s) could not be put back: ${failures.slice(0, 3).join("; ")}`,
    );
  pruneEmptyDirs(journal.displaceTo);
  rmSync(journalFile(home), { force: true });
  fsyncPath(join(home, "run"));
  opts.logger?.log("warn", "a go back that did not happen was undone: the newer data is back");
  return true;
}

export type PendingGoBack = "none" | "undone" | "settled";

/**
 * At Gateway start, before anything opens the data: settles a go-back that was cut short.
 * Fails closed (writes the reason where the start-up screen shows it and throws) when it must
 * undo and cannot.
 */
export function finishPendingGoBack(
  home: string,
  opts: GoBackOptions & { build: string; version?: string },
): PendingGoBack {
  const refuse = (why: string): never => {
    const message = `Psyche was going back to an earlier version when it was interrupted, and could not put your newer data back (${why}). That data is in backups/pre-update inside Psyche's data folder. Please don't open Psyche again until it has been put back. If you have done that yourself, delete run/go-back.json.`;
    try {
      writeJsonDurable(join(home, UPDATE_FAILED_FILE), {
        build: opts.build,
        key: "go-back-interrupted",
        kind: "deterministic",
        attempts: 1,
        retryAfter: null,
        from: "unknown",
        to: opts.version ?? "unknown",
        migration: null,
        at: (opts.now ?? (() => new Date()))().toISOString(),
        snapshot: null,
        restored: false,
        message,
      } satisfies UpdateFailure);
    } catch {
      // The error below still stops the start.
    }
    throw new PsycheError("unavailable", message, { details: { reason: "go_back_interrupted" } });
  };
  let journal: GoBackJournal | undefined;
  try {
    journal = readJournal(home);
  } catch (err) {
    return refuse(errorText(err));
  }
  if (journal === undefined) return "none";
  // The build being left is starting, so the swap to the older one did not happen; and nothing
  // has touched the restored data since. Then the data belongs to the newer build again.
  const notSwapped =
    journal.leavingBuild === opts.build &&
    (journal.phase === "restoring" || liveFingerprint(opts.dbPath) === journal.liveFingerprint);
  if (!notSwapped) {
    opts.logger?.log("warn", "a go back finished: the newer data is kept aside", {
      folder: journal.displaceTo,
    });
    rmSync(journalFile(home), { force: true });
    fsyncPath(join(home, "run"));
    return "settled";
  }
  try {
    undoGoBack(home, undefined, opts);
  } catch (err) {
    return refuse(errorText(err));
  }
  return "undone";
}
