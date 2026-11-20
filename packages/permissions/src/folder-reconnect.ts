import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
}

/** The identity of a plain folder at `path` (never a link); undefined for anything else. */
export async function folderRefOf(path: string): Promise<FolderRef | undefined> {
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    return { dev: info.dev.toString(), ino: info.ino.toString() };
  } catch {
    return undefined;
  }
}

export const sameRef = (a: FolderRef, b: FolderRef): boolean => a.dev === b.dev && a.ino === b.ino;

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
  /** Most folders looked at. */
  maxDirs?: number;
  /** Longest search, in ms. */
  maxMs?: number;
  /** How far under each search root. */
  maxDepth?: number;
}

/**
 * Looks for the folder with identity `ref`: the old parent first (a rename), then the owner's
 * home, a few levels deep. Links are never followed, dot folders and `~/Library` are skipped, and
 * the search stops at the budget. Only a suggestion: `checkReconnect` judges the answer.
 */
export async function locateFolder(
  stored: string,
  ref: FolderRef,
  env: FolderAccessEnv = {},
  budget: LocateBudget = {},
): Promise<string | undefined> {
  const maxDirs = budget.maxDirs ?? 3000;
  const deadline = Date.now() + (budget.maxMs ?? 800);
  const maxDepth = budget.maxDepth ?? 3;
  let seen = 0;
  const roots = [dirname(resolve(stored)), resolve(env.home ?? homedir())];
  const visited = new Set<string>();
  for (const root of roots) {
    let level = [root];
    for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        if (visited.has(dir)) continue;
        visited.add(dir);
        if (seen++ >= maxDirs || Date.now() > deadline) return undefined;
        let names: Dirent[];
        try {
          names = await readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const d of names) {
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
