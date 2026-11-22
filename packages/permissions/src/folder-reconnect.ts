import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isUnderHostPath, sameHostPath } from "@psyche/hostfs";
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
  /** Folders never to open (a granted root whose look hung or failed, and what is under it). */
  skip?: (dir: string) => boolean;
}

/** The folders under home that macOS guards with a privacy prompt (plus the media libraries). */
const PRIVACY_FOLDERS = new Set([
  "desktop",
  "documents",
  "downloads",
  "pictures",
  "movies",
  "music",
]);

/** `~/Documents` for `~/Documents/x/y`, when that is one of the guarded folders; else undefined. */
function privacyRoot(dir: string, home: string): string | undefined {
  if (!isUnderHostPath(dir, home)) return undefined;
  const first = relative(home, dir).split(sep)[0] ?? "";
  return PRIVACY_FOLDERS.has(first.toLowerCase()) ? join(home, first) : undefined;
}

/**
 * Looks for the folder with identity `ref` in the few places a rename or move lands, without
 * opening anything the owner has not already opened to Psyche:
 * - the old parent: its children are looked at, and opened one level more only when the parent is
 *   an ordinary folder under home (never home itself, never a folder outside home, never
 *   `/Volumes`: those have children that are other volumes or guarded folders);
 * - each ancestor of it up to home: its direct children are looked at (an `lstat`, which raises no
 *   privacy prompt), never opened;
 * - the subtrees of folders already granted.
 * A guarded folder (Desktop, Documents, Downloads, Pictures, Movies, Music) is opened only when it
 * or an ancestor is granted, or it holds the old parent (a grant lives there, so the owner has
 * been through its prompt). Links are never followed, dot folders and `~/Library` are skipped, and
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
  const granted = (budget.grantedRoots ?? []).map((g) => resolve(g));
  const parent = dirname(resolve(stored));
  const ownGuard = privacyRoot(parent, home);
  let seen = 0;
  const visited = new Set<string>();
  const exhausted = (): boolean => seen++ >= maxEntries || now() > deadline;
  const mayOpen = (dir: string): boolean => {
    if (budget.skip?.(dir) === true) return false;
    const guard = privacyRoot(dir, home);
    if (guard === undefined) return true;
    if (guard === ownGuard) return true;
    return granted.some((g) => sameHostPath(g, dir) || isUnderHostPath(dir, g));
  };

  const scan = async (root: string, maxDepth: number): Promise<string | undefined> => {
    let level = [root];
    for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        if (visited.has(dir) || !mayOpen(dir)) continue;
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

  // Home, a folder outside home and `/Volumes` hold other volumes and the guarded folders as
  // children: look at those children, do not open them.
  const ordinary = isUnderHostPath(parent, home) && !sameHostPath(parent, home);
  const hit = await scan(parent, ordinary ? 1 : 0);
  if (hit !== undefined) return hit;
  // Ancestors up to home: their direct children only.
  if (ordinary) {
    for (let dir = dirname(parent); ; dir = dirname(dir)) {
      const found = await scan(dir, 0);
      if (found !== undefined) return found;
      if (sameHostPath(dir, home) || !isUnderHostPath(dir, home)) break;
    }
  }
  for (const root of granted) {
    const found = await scan(root, 3);
    if (found !== undefined) return found;
  }
  return undefined;
}

const GLOB_CHARS = /[*?[\]{}]/;

/** One glob path segment as an anchored, case-folded regular expression. */
function segmentPattern(seg: string): RegExp {
  const body = seg
    .split("")
    .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`, "i");
}

/**
 * Whether a deny or ask rule names the place `old` or something under it, so that moving the
 * folder would leave the rule matching nothing (it would stop narrowing what it narrowed). The
 * rule's path is matched segment by segment against the old path, `**` standing for any number
 * of segments; a rule whose segments are all `**` or that only match by what comes after the old
 * folder (`**` then `*.env`) is not about it. Case is folded, `~` is the owner's home, and a
 * sibling that merely starts with the same letters (`AB` for `A`) is another folder.
 */
export function ruleNamesOldPath(rule: string, old: string, home: string): boolean {
  const raw = rule.trim();
  let arg: string | undefined;
  if (raw.startsWith("path:")) arg = raw.slice(5);
  else if (/^(origin|recipient|app|account|command):/.test(raw)) return false;
  else {
    const call = /^([^()]+)\((.+)\)$/.exec(raw);
    const a = call?.[2];
    // Only an argument that reads as a path is a path rule (as `parseRule` decides).
    if (a !== undefined && (a.startsWith("/") || a.startsWith("**") || a.startsWith("~"))) arg = a;
  }
  if (arg === undefined) return false;
  if (arg === "~" || arg.startsWith("~/")) arg = `${home}${arg.slice(1)}`;
  const oldSegs = old.split("/").filter((x) => x.length > 0);
  // A segment with `**` stuck to text (`**A`, `Wo**`) is read as `.*` by the matcher, crossing
  // `/`: take both readings, one segment (`X*Y`) or several (`X*`, `**`, `*Y`), and OR them.
  let variants: string[][] = [[]];
  for (const g of arg.split("/").filter((x) => x.length > 0)) {
    if (g !== "**" && g.includes("**")) {
      const [x = "", ...rest] = g.split("**");
      const y = rest.join("**");
      const one = `${x}*${y.replaceAll("**", "*")}`;
      variants = variants.flatMap((v) => [
        [...v, one],
        [...v, `${x}*`, "**", `*${y.replaceAll("**", "*")}`],
      ]);
    } else variants = variants.map((v) => [...v, g]);
    if (variants.length > 64) return true;
  }
  return variants.some((segs) => segsNameOld(segs, oldSegs));
}

function segsNameOld(segs: string[], oldSegs: string[]): boolean {
  const fold = (x: string): string => x.toLowerCase();
  const patterns = segs.map((g) => (GLOB_CHARS.test(g) ? segmentPattern(g) : undefined));
  const memo = new Map<string, boolean>();
  const walk = (i: number, j: number, used: boolean): boolean => {
    const key = `${i}:${j}:${used}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let out: boolean;
    // The old path is used up: the rest of the rule can only match what is under it.
    if (j === oldSegs.length) out = used;
    else if (i === segs.length) out = false;
    else if (segs[i] === "**") out = walk(i + 1, j, used) || walk(i, j + 1, used);
    else {
      const g = patterns[i];
      const seg = oldSegs[j] ?? "";
      const same = g !== undefined ? g.test(seg) : fold(segs[i] ?? "") === fold(seg);
      out = same && walk(i + 1, j + 1, true);
    }
    memo.set(key, out);
    return out;
  };
  return walk(0, 0, false);
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
