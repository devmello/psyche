import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { PsycheError } from "@psyche/protocol";

/**
 * The backups directory, `$PSYCHE_HOME/backups/` (0700): what `psyche backup create` writes by
 * default and what `backup.*` lists. Archives are addressed by file name only, never by a path a
 * client chooses.
 */

export interface BackupEntry {
  file: string;
  createdAt: string;
  bytes: number;
  encrypted: boolean;
  verifiedAt: string | null;
}

const ARCHIVE = /^psyche-[A-Za-z0-9_.:-]+\.tar\.gz(\.age)?$/;
const VERIFIED = ".verified.json";

export function backupsDir(home: string): string {
  return join(home, "backups");
}

export function ensureBackupsDir(home: string): string {
  const dir = backupsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** `psyche-<ISO time with : and . as ->.tar.gz[.age]`. */
export function backupFileName(now: Date, encrypted: boolean): string {
  return `psyche-${now.toISOString().replace(/[:.]/g, "-")}.tar.gz${encrypted ? ".age" : ""}`;
}

/** The time a backup name encodes, or null for a renamed file. */
export function timeFromName(file: string): string | null {
  const m = /^psyche-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(file);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
}

function readVerified(dir: string): Record<string, string> {
  try {
    const v = JSON.parse(readFileSync(join(dir, VERIFIED), "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeVerified(dir: string, map: Record<string, string>): void {
  const tmp = join(dir, `${VERIFIED}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
  renameSync(tmp, join(dir, VERIFIED));
}

/** Resolves a client-given file name to an archive inside the backups dir, or throws. */
export function resolveBackupFile(home: string, file: string): string {
  if (!ARCHIVE.test(file)) {
    throw new PsycheError("invalid_params", `not a backup file name: ${JSON.stringify(file)}`);
  }
  const dir = backupsDir(home);
  const path = join(dir, file);
  if (!existsSync(path)) throw new PsycheError("not_found", `no backup named ${file}`);
  const real = realpathSync(path);
  if (!real.startsWith(realpathSync(dir) + sep)) {
    throw new PsycheError("invalid_params", `${file} is outside the backups directory`);
  }
  return real;
}

export function backupEntry(home: string, file: string): BackupEntry {
  const path = join(backupsDir(home), file);
  const st = statSync(path);
  return {
    file,
    createdAt: timeFromName(file) ?? st.mtime.toISOString(),
    bytes: st.size,
    encrypted: file.endsWith(".age"),
    verifiedAt: readVerified(backupsDir(home))[file] ?? null,
  };
}

/** Archives in the backups dir, newest first. */
export function listBackups(home: string): BackupEntry[] {
  const dir = backupsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => ARCHIVE.test(f) && statSync(join(dir, f)).isFile())
    .map((f) => backupEntry(home, f))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function markVerified(home: string, file: string, at: Date): void {
  const dir = backupsDir(home);
  const map = readVerified(dir);
  map[file] = at.toISOString();
  writeVerified(dir, map);
}

export function deleteBackup(home: string, file: string): void {
  rmSync(resolveBackupFile(home, file));
  const dir = backupsDir(home);
  const map = readVerified(dir);
  if (file in map) {
    delete map[file];
    writeVerified(dir, map);
  }
}
