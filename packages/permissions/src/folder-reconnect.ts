import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isUnderHostPath } from "@psyche/hostfs";
import { assertFolderGrantable, type FolderAccessEnv, sameRootSpelling } from "./folder-access.ts";

/**
 * Reconnecting a granted folder the owner renamed or moved in Finder. The grant stores the folder's
 * identity (volume id and inode, `FolderRef`) next to its path. When the path is gone, Settings
 * offers "Reconnect <name>?" with the place the same folder is at now; the owner's tap re-points
 * the grant. Nothing here re-points on its own, and a re-point passes every check a fresh grant
 * does (`assertFolderGrantable`), plus these: the old path is missing (not swapped for a link or
 * another folder), the new place is a plain folder reached through no link, and it is the same
 * folder (same volume and inode) as the one granted.
 */

export interface FolderRef {
  dev: string;
  ino: string;
  /** Birth time in ns: inode numbers are reused (ext4, FAT, SMB), the birth time is not. */
  birth: string;
}

/**
 * The identity of a plain folder at `path` (never a link); undefined for anything else, and for a
 * file system that reports no birth time (its inode alone would not tell folders apart).
 */
export async function folderRefOf(path: string): Promise<FolderRef | undefined> {
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || info.birthtimeNs <= 0n) return undefined;
    return {
      dev: info.dev.toString(),
      ino: info.ino.toString(),
      birth: info.birthtimeNs.toString(),
    };
  } catch {
    return undefined;
  }
}

export const sameRef = (a: FolderRef, b: FolderRef): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.birth === b.birth;

/** Whether nothing is at `path` (ENOENT; a link, even a dangling one, is something). */
export async function pathIsGone(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export interface LocateBudget {
  /** Most entries looked at. */
  maxEntries?: number;
  /** Longest search, in ms. */
  maxMs?: number;
  /** The clock the deadline is read from (default `Date.now`). */
  now?: () => number;
  /** Granted folders to search inside (their subtrees, a few levels deep). */
  grantedRoots?: readonly string[];
}

/**
 * Looks for the folder with identity `ref` in the few places a rename or move lands: the old
 * parent (two levels), each ancestor of it up to home (their direct children only, which are
 * looked at but never opened, so no privacy prompt for Desktop or Documents), and the subtrees of
 * folders already granted. Links are never followed, dot folders and `~/Library` are skipped, and
 * the deadline is checked for every entry. Only a suggestion: `checkReconnect` judges the answer.
 */
export async function locateFolder(
  stored: string,
  ref: FolderRef,
  env: FolderAccessEnv = {},
  budget: LocateBudget = {},
): Promise<string | undefined> {
  const maxEntries = budget.maxEntries ?? 2000;
  const now = budget.now ?? Date.now;
  const deadline = now() + (budget.maxMs ?? 800);
  const home = resolve(env.home ?? homedir());
  let seen = 0;
  const visited = new Set<string>();
  const exhausted = (): boolean => seen++ >= maxEntries || now() > deadline;

  const scan = async (root: string, maxDepth: number): Promise<string | undefined> => {
    let level = [root];
    for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        if (visited.has(dir)) continue;
        visited.add(dir);
        let names: Dirent[];
        try {
          names = await readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const d of names) {
          if (exhausted()) return undefined;
          // A symlink is not a directory here: links are never followed.
          if (!d.isDirectory() || d.name.startsWith(".") || d.name === "Library") continue;
          const full = join(dir, d.name);
          const found = await folderRefOf(full);
          if (found !== undefined && sameRef(found, ref)) return full;
          next.push(full);
        }
      }
      level = next;
    }
    return undefined;
  };

  const parent = dirname(resolve(stored));
  const hit = await scan(parent, 1);
  if (hit !== undefined) return hit;
  // Ancestors up to home: their direct children only.
  if (isUnderHostPath(parent, home) || parent === home) {
    for (let dir = dirname(parent); ; dir = dirname(dir)) {
      if (!isUnderHostPath(dir, home) && dir !== home) break;
      const found = await scan(dir, 0);
      if (found !== undefined) return found;
      if (dir === home) break;
    }
  }
  for (const root of budget.grantedRoots ?? []) {
    const found = await scan(root, 3);
    if (found !== undefined) return found;
  }
  return undefined;
}

export type ReconnectRefusal =
  | "no_identity"
  | "still_there"
  | "not_a_folder"
  | "reached_through_link"
  | "different_folder";

export class ReconnectRefused extends Error {
  readonly reason: ReconnectRefusal;
  constructor(reason: ReconnectRefusal) {
    super(`cannot reconnect: ${reason}`);
    this.reason = reason;
  }
}

/**
 * The checks of a re-point, in the order that matters. Returns the real path to grant (judged by
 * `assertFolderGrantable`, which throws `forbidden` for a sensitive root exactly as a fresh grant
 * would) or throws `ReconnectRefused`.
 */
export async function checkReconnect(
  stored: string,
  to: string,
  ref: FolderRef | undefined,
  env: FolderAccessEnv = {},
): Promise<string> {
  if (ref === undefined) throw new ReconnectRefused("no_identity");
  // Only a vanished path is re-pointed: a root swapped for a link or another folder stays refused.
  if (!(await pathIsGone(stored))) throw new ReconnectRefused("still_there");
  // Not a folder, or the final component is a link.
  if ((await folderRefOf(to)) === undefined) throw new ReconnectRefused("not_a_folder");
  let real: string;
  try {
    real = await realpath(to);
  } catch {
    throw new ReconnectRefused("not_a_folder");
  }
  // A link anywhere in the chain (a swapped parent) leads somewhere else than `to`.
  if (!sameRootSpelling(real, to, env)) throw new ReconnectRefused("reached_through_link");
  const again = await folderRefOf(real);
  if (again === undefined || !sameRef(again, ref)) throw new ReconnectRefused("different_folder");
  const judged = await assertFolderGrantable(real, env);
  if (judged === undefined) throw new ReconnectRefused("not_a_folder");
  return judged;
}

/** The folder's name for the card ("Reconnect <name>?"). */
export const reconnectName = (stored: string): string => basename(stored);
