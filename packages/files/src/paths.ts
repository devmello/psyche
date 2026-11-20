import { lstatSync, statSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  canonicalHostPath,
  HostPathError,
  isMacMagicPath,
  isUnderHostPath,
  isWin32HostPath,
  relativeHostPath,
  sameHostPath,
} from "@psyche/hostfs";
import { PsycheError } from "@psyche/protocol";

/** A granted folder as `permissions.policy.folders` lists it (real path, `ro` or `rw`). */
export interface GrantedFolder {
  path: string;
  mode: "ro" | "rw";
  /** One attached file: it matches that exact path, and only while it is still a regular file. */
  file?: true;
}

/**
 * The normalized absolute path the broker checks (pure: no file system access). `..` segments
 * resolve here, so `/granted/../outside` is judged as `/outside`, never as a path under
 * `/granted`. On Windows it is the broker's own form (`@psyche/hostfs`): a drive or UNC path, and
 * a name Win32 would rewrite (`a.txt:stream`, `Docs.`, `NUL`, `DOCUME~1`) is refused.
 */
export function canonicalTarget(p: string): string {
  if (p.includes("\0")) throw new PsycheError("invalid_params", "NUL in path");
  if (process.platform !== "win32") {
    const abs = resolve(p);
    // `/.nofollow/<abs>` and `/.vol/..` open another file, past every root check below.
    if (isMacMagicPath(abs)) {
      throw new PsycheError("forbidden", `${p} is not a path Psyche can use`, {
        details: { reason: "protected_path" },
      });
    }
    return abs;
  }
  try {
    const c = canonicalHostPath(p);
    // Windows would read `/x` as `\x` on the current drive: only drive and UNC paths name a file.
    if (!isWin32HostPath(c)) throw new HostPathError(`path is not absolute: ${JSON.stringify(p)}`);
    return c;
  } catch (err) {
    if (err instanceof HostPathError) throw new PsycheError("invalid_params", err.message);
    throw err;
  }
}

/** `child` equals `root` or lies under it, by whole segments (Windows paths without case). */
export function isUnder(child: string, root: string): boolean {
  return isUnderHostPath(child, root);
}

function isRegularFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    // A hard link is another name for a file that may be somewhere else (a swapped-in link to
    // a key): an attached file has exactly one name.
    return st.isFile() && st.nlink === 1;
  } catch {
    return false;
  }
}

/**
 * Defense in depth behind the broker: the canonical path must lie in a granted folder, and in
 * an `rw` one for a write. The broker already denies these calls (`folder:not_granted` /
 * `folder:read_only`); the executor refuses again so a revoked folder or a mis-wired registry
 * never reaches the disk. `undefined` folders means the broker's check is the only one.
 */
export function assertGranted(
  path: string,
  folders: readonly GrantedFolder[] | undefined,
  access: "read" | "write",
): void {
  if (folders === undefined) return;
  // The longest matching root decides, as in the broker.
  let best: GrantedFolder | undefined;
  for (const f of folders) {
    let root: string;
    try {
      root = canonicalTarget(f.path);
    } catch {
      // A stored grant that names nothing usable (`/.nofollow/..`) covers nothing.
      continue;
    }
    // A file entry is that exact path, and only while it is still a regular file: a file
    // replaced by a folder opens nothing inside it.
    const hit = f.file === true ? isUnder(path, root) && isUnder(root, path) : isUnder(path, root);
    if (hit && f.file === true && !isRegularFile(root)) continue;
    if (hit && (best === undefined || root.length > best.path.length)) {
      best = { path: root, mode: f.mode };
    }
  }
  if (best === undefined) {
    // Security §3.13: the agent may ask for it with request_permission.
    throw new PsycheError("forbidden", `${path} is outside every granted folder`, {
      details: {
        missing: { need: "folder", path, access: access === "write" ? "read_write" : "read" },
      },
    });
  }
  if (access === "write" && best.mode !== "rw") {
    throw new PsycheError("forbidden", `${best.path} is granted read-only`, {
      details: { missing: { need: "folder", path: best.path, access: "read_write" } },
    });
  }
}

/** Names under one of Psyche's own working folders that stay protected: agent config and tokens. */
const OWN_DIR_PRIVATE = new Set([
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  // NTFS opens `claude.md` as `CLAUDE.md`: Windows compares these upper-cased.
  ...(process.platform === "win32" ? ["CLAUDE.MD", "AGENTS.MD", "GEMINI.MD"] : []),
]);

/**
 * Whether `path` lies in a protected root. `ownDirs` are folders Psyche creates for its own runs
 * inside `$PSYCHE_HOME` (the subscription CLI working directories): they are exempt from the roots
 * that contain them, and only from those, so the rest of `$PSYCHE_HOME` stays protected. Inside
 * one, dotfiles and dot-folders (`.psyche-mcp-*.json` holds the tool bridge token, `.claude`,
 * `.codex` hold CLI settings) and the CLIs' instruction files stay protected as well.
 */
export function isProtectedPath(
  path: string,
  roots: readonly string[] | undefined,
  ownDirs: readonly string[] = [],
): boolean {
  // `/.nofollow/<abs>` opens `<abs>` past every root below: never a usable path on macOS.
  if (isMacMagicPath(path)) return true;
  if (roots === undefined) return false;
  const own = ownDirs.map(canonicalTarget).find((d) => isUnder(path, d));
  for (const raw of roots) {
    const root = canonicalTarget(raw);
    if (!isUnder(path, root)) continue;
    if (own === undefined || !isUnder(own, root)) return true;
    const first = relativeHostPath(own, path).split("/")[0] ?? "";
    const name = process.platform === "win32" ? first.toUpperCase() : first;
    if (first.startsWith(".") || OWN_DIR_PRIVATE.has(name)) return true;
  }
  return false;
}

/**
 * Refuses paths in or under a protected root (Psyche's own home, credential stores), checked
 * before any grant: a granted ancestor such as `~` never opens them (#285).
 */
export function assertNotProtected(
  path: string,
  roots: readonly string[] | undefined,
  ownDirs: readonly string[] = [],
  writeRoots?: readonly string[] | WriteProtection,
): void {
  // Psyche's own working folders (inside a protected root) keep their rules below.
  const own = ownDirs.some((d) => isUnder(path, canonicalTarget(d)));
  const wp = writeRoots === undefined || own ? undefined : asWriteProtection(writeRoots);
  if (wp !== undefined) {
    const root =
      writeProtectedRoot(path, wp.roots) ??
      (wp.dotHome === undefined ? undefined : dotHomeEntry(path, wp.dotHome));
    if (root !== undefined) {
      throw new PsycheError(
        "forbidden",
        `${path} is a protected location: Psyche never writes where code runs at login, in a shell or when an app opens`,
        { details: { reason: "protected_path", root, access: "write" } },
      );
    }
  }
  if (!isProtectedPath(path, roots, ownDirs)) return;
  const root = (roots ?? []).map(canonicalTarget).find((r) => isUnder(path, r));
  throw new PsycheError("forbidden", `${path} is a protected location`, {
    details: { reason: "protected_path", root },
  });
}

/**
 * What an agent write may not reach: the write-protected roots, and, when the write falls under
 * a share of the whole home folder (`dotHome` is that home), any dot entry directly in it
 * (`~/.newrc`, `~/.tool/config`): the owner's configuration, never the agent's to write.
 */
export interface WriteProtection {
  roots: readonly string[];
  dotHome?: string;
}

function asWriteProtection(w: readonly string[] | WriteProtection): WriteProtection {
  return Array.isArray(w) ? { roots: w } : (w as WriteProtection);
}

/**
 * Whether a write to `path` falls under a share of the whole home folder: the longest granted
 * folder holding it is `home` itself or a folder around it (an older home-root share). A folder
 * the owner shared inside home (`~/.dotfiles`, `~/Projects`) decides for itself. With no folder
 * list the broker alone decides, and the rule applies.
 */
export function homeShareGoverns(
  path: string,
  home: string,
  folders: readonly GrantedFolder[] | undefined,
): boolean {
  if (folders === undefined) return true;
  let best: string | undefined;
  for (const f of folders) {
    if (f.file === true) continue;
    let root: string;
    try {
      root = canonicalTarget(f.path);
    } catch {
      continue;
    }
    if (isUnder(path, root) && (best === undefined || root.length > best.length)) best = root;
  }
  if (best === undefined) return false;
  try {
    return isUnder(canonicalTarget(home), best);
  } catch {
    return false;
  }
}

/**
 * The dot entry directly in `home` that `path` is or lies in (`~/.newrc`, `~/.tool`), else
 * undefined. By name, folded as the disk folds it, and by identity: an existing folder above the
 * path whose parent is `home` itself, however either is spelled.
 */
export function dotHomeEntry(path: string, home: string): string | undefined {
  let h: string;
  try {
    h = canonicalTarget(home);
  } catch {
    return undefined;
  }
  const fold = process.platform === "linux" ? (p: string) => p : foldPathName;
  const target = fold(path);
  const folded = fold(h);
  if (isUnder(target, folded) && target !== folded) {
    const first = relativeHostPath(folded, target).split(/[\\/]/)[0] ?? "";
    if (first.startsWith(".")) return join(h, first);
  }
  const homeId = fileIdentity(h);
  if (homeId === undefined) return undefined;
  for (let p = path; dirname(p) !== p; p = dirname(p)) {
    if (basename(p).startsWith(".") && fileIdentity(dirname(p)) === homeId) return p;
  }
  return undefined;
}

/**
 * A path as a case- and normalization-insensitive disk compares names (APFS by default, NTFS
 * for case): compatibility-normalized (`ſ` is `s`, `ﬁ` is `fi`, the Kelvin sign is `K`, an NFD
 * `é` is the NFC one) and case-folded (`ß` and `ẞ` are `ss`: lower, upper, then lower again).
 * Over-folding only refuses more.
 */
export function foldPathName(p: string): string {
  return p.normalize("NFKC").toLowerCase().toUpperCase().toLowerCase().normalize("NFKC");
}

/** `dev:ino` of what `p` leads to now, or undefined when it does not exist. */
function fileIdentity(p: string): string | undefined {
  try {
    const st = statSync(p, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

/**
 * The write-protected root (`~/Applications`, `~/Library/LaunchAgents`, `~/.zshrc`...) that
 * `path` is, or lies under, else undefined. Judged two ways, so no other spelling of a protected
 * name reaches it (review r1: `.zſhrc` and `.proﬁle` opened `.zshrc` and `.profile` on APFS):
 * - by name, folded as the disk folds it (`foldPathName`; byte for byte on Linux), which also
 *   covers a file that does not exist yet;
 * - by identity: the path or any existing folder above it is the same file (`dev:ino`) as an
 *   existing protected root, however it is spelled (a hard link counts too).
 */
export function writeProtectedRoot(
  path: string,
  writeRoots: readonly string[],
): string | undefined {
  const fold = process.platform === "linux" ? (p: string) => p : foldPathName;
  const target = fold(path);
  const roots: string[] = [];
  for (const raw of writeRoots) {
    try {
      roots.push(canonicalTarget(raw));
    } catch {
      // A root that names nothing usable protects nothing.
    }
  }
  for (const root of roots) if (isUnder(target, fold(root))) return root;
  const ids = new Map<string, string>();
  for (const root of roots) {
    const id = fileIdentity(root);
    if (id !== undefined && !ids.has(id)) ids.set(id, root);
  }
  if (ids.size === 0) return undefined;
  for (let p = path; ; p = dirname(p)) {
    const id = fileIdentity(p);
    const hit = id === undefined ? undefined : ids.get(id);
    if (hit !== undefined) return hit;
    if (dirname(p) === p) return undefined;
  }
}

/**
 * Refuses unless `path` is its own real path: the deepest existing ancestor resolves to itself
 * and the final component, if present, is not a symlink (dangling or not). The broker compares
 * paths without resolving links, so a link inside a granted folder could otherwise point the
 * approved path anywhere on disk.
 */
export async function assertNoSymlinks(path: string): Promise<void> {
  const moved = () =>
    new PsycheError("forbidden", `${path} goes through a symlink; use the real path`);
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      // Windows: the real path keeps the case on disk, and a short name comes back long.
      if (!sameHostPath(await realpath(dir), dir)) throw moved();
      break;
    } catch (err) {
      if (err instanceof PsycheError || (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (dirname(dir) === dir) break;
    }
  }
  try {
    if ((await lstat(path)).isSymbolicLink()) throw moved();
  } catch (err) {
    if (err instanceof PsycheError || (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Maps `ENOENT` / `ENOTDIR` / `EISDIR` / `ELOOP` to error codes the agent can act on. */
export function fsError(err: unknown, path: string): unknown {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return new PsycheError("not_found", `${path} does not exist`);
  if (code === "ENOTDIR") return new PsycheError("invalid_params", `${path} is not a folder`);
  if (code === "EISDIR") return new PsycheError("invalid_params", `${path} is a folder`);
  if (code === "ENAMETOOLONG")
    return new PsycheError("invalid_params", `${path} has a name that is too long`);
  // O_NOFOLLOW on a link swapped in after the check.
  if (code === "ELOOP" || code === "EMLINK") {
    return new PsycheError("forbidden", `${path} is a symlink; use the real path`);
  }
  return err;
}
