import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PsycheError } from "@psyche/protocol";

/** A granted folder as `permissions.policy.folders` lists it (real path, `ro` or `rw`). */
export interface GrantedFolder {
  path: string;
  mode: "ro" | "rw";
}

/**
 * The normalized absolute path the broker checks (pure: no file system access). `..` segments
 * resolve here, so `/granted/../outside` is judged as `/outside`, never as a path under
 * `/granted`.
 */
export function canonicalTarget(p: string): string {
  if (p.includes("\0")) throw new PsycheError("invalid_params", "NUL in path");
  return resolve(p);
}

/** `child` equals `root` or lies under it, by whole segments. */
export function isUnder(child: string, root: string): boolean {
  if (root === "/") return child.startsWith("/");
  return child === root || child.startsWith(`${root}/`);
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
    const root = canonicalTarget(f.path);
    if (isUnder(path, root) && (best === undefined || root.length > best.path.length)) {
      best = { path: root, mode: f.mode };
    }
  }
  if (best === undefined) {
    throw new PsycheError("forbidden", `${path} is outside every granted folder`);
  }
  if (access === "write" && best.mode !== "rw") {
    throw new PsycheError("forbidden", `${best.path} is granted read-only`);
  }
}

/**
 * Refuses paths in or under a protected root (Psyche's own home, credential stores), checked
 * before any grant: a granted ancestor such as `~` never opens them (#285).
 */
export function assertNotProtected(path: string, roots: readonly string[] | undefined): void {
  if (roots === undefined) return;
  for (const raw of roots) {
    const root = canonicalTarget(raw);
    if (isUnder(path, root)) {
      throw new PsycheError("forbidden", `${path} is a protected location`, {
        details: { reason: "protected_path", root },
      });
    }
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
      if ((await realpath(dir)) !== dir) throw moved();
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
  // O_NOFOLLOW on a link swapped in after the check.
  if (code === "ELOOP" || code === "EMLINK") {
    return new PsycheError("forbidden", `${path} is a symlink; use the real path`);
  }
  return err;
}
