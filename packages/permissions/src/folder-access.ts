import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { PsycheError } from "@psyche/protocol";

/**
 * Folder access requested by the agent (security §3.5, "Folder access"). The owner's own pick is
 * what is granted: the path is resolved to its real path (symlinks, `..`) and refused when it is
 * a sensitive root, an ancestor of one, or not a folder. Nothing broader than the pick is ever
 * granted, and taint always limits the answer to `once` (§3.6; no exception).
 */

export interface FolderGrantEntry {
  path: string;
  mode: "ro" | "rw";
}

/** A folder grant whose lifetime is the conversation, not Settings. */
export interface SessionFolderGrant extends FolderGrantEntry {
  threadId: string;
}

export interface FolderAccessEnv {
  /** The owner's home directory. */
  home?: string;
  /** `$PSYCHE_HOME`. */
  psycheHome?: string;
  /** Extra protected locations (credential stores) as written; real paths are added too. */
  protectedRoots?: readonly string[];
}

/** System roots refused as themselves and as ancestors, but not for their subfolders. */
const EXACT_ROOTS = ["/", "/Users", "/home", "/Volumes", "/private", "/var", "/private/var"];

/** System roots refused with everything under them. */
const SUBTREE_ROOTS = [
  "/System",
  "/Library",
  "/etc",
  "/private/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/dev",
  "/cores",
  "/Applications",
];

/** Under the home directory: refused with everything under them. */
const HOME_SENSITIVE = [
  "Library",
  ".ssh",
  ".gnupg",
  ".aws",
  ".config/gcloud",
  ".config/gh",
  ".kube",
  ".docker",
  ".netrc",
  ".psyche",
  ".Trash",
];

function under(child: string, root: string): boolean {
  if (root === "/") return true;
  return child === root || child.startsWith(`${root}/`);
}

/** The roots a pick may not equal or contain (and, for subtree roots, lie under). */
export function sensitiveRoots(env: FolderAccessEnv = {}): { exact: string[]; subtree: string[] } {
  const home = resolve(env.home ?? homedir());
  const subtree = new Set<string>(SUBTREE_ROOTS);
  for (const rel of HOME_SENSITIVE) subtree.add(`${home}/${rel}`);
  if (env.psycheHome !== undefined) subtree.add(resolve(env.psycheHome));
  for (const p of env.protectedRoots ?? []) subtree.add(resolve(p));
  return { exact: [...EXACT_ROOTS, home], subtree: [...subtree] };
}

export type FolderRefusal = "sensitive_root" | "contains_sensitive_root" | "not_absolute";

/**
 * Why a normalised, real absolute path may not be granted, or `undefined` when it may. `/`, the
 * home root, `~/Library`, `~/.ssh` and `~/.psyche` are refused; so is any folder that contains
 * one of them (the home root contains `~/.ssh`). A folder inside home such as `~/Projects` passes.
 */
export function refuseFolder(real: string, env: FolderAccessEnv = {}): FolderRefusal | undefined {
  if (!real.startsWith("/")) return "not_absolute";
  const { exact, subtree } = sensitiveRoots(env);
  if (exact.includes(real)) return "sensitive_root";
  for (const root of subtree) if (under(real, root)) return "sensitive_root";
  for (const root of [...exact, ...subtree]) {
    if (root !== real && under(root, real)) return "contains_sensitive_root";
  }
  return undefined;
}

/**
 * The real path of the folder the owner picked, refused when it is sensitive. Resolves `..` and
 * symlinks first, so a link to `~/.ssh` is judged as `~/.ssh`.
 */
export async function resolveFolderPick(raw: string, env: FolderAccessEnv = {}): Promise<string> {
  if (raw.includes("\0") || !raw.startsWith("/")) {
    throw new PsycheError("invalid_params", "pick an absolute folder path");
  }
  let real: string;
  try {
    real = await realpath(resolve(raw));
    if (!(await stat(real)).isDirectory()) {
      throw new PsycheError("invalid_params", `${raw} is not a folder`);
    }
  } catch (err) {
    if (err instanceof PsycheError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PsycheError("not_found", `${raw} does not exist`);
    }
    throw err;
  }
  // Protected roots are compared as real paths too (/private/var, a linked ~/.ssh).
  const protectedReal: string[] = [];
  for (const p of env.protectedRoots ?? []) {
    try {
      protectedReal.push(await realpath(p));
    } catch {
      // Not there: the written path is enough.
    }
  }
  const refusal = refuseFolder(real, {
    ...env,
    protectedRoots: [...(env.protectedRoots ?? []), ...protectedReal],
  });
  if (refusal !== undefined) {
    throw new PsycheError("forbidden", `${real} cannot be shared with the agent`, {
      details: { reason: refusal, path: real },
    });
  }
  return real;
}

/** What the Gateway made of the folder the agent named, shown on the card as the pre-filled pick. */
export type RequestedFolder =
  | { status: "ok"; path: string }
  | { status: "blocked"; path: string; reason: FolderRefusal }
  | { status: "missing" };

/**
 * Resolves the path the agent asked for (`~/` expanded, `..` and symlinks resolved). It must exist
 * and be a directory; a sensitive root is `blocked` (the card disables Allow and offers the
 * picker); anything else unusable is `missing` (the card falls back to the picker). The broker
 * re-resolves whatever the owner finally allows, so this is a preview, never a grant.
 */
export async function resolveRequestedFolder(
  raw: string,
  env: FolderAccessEnv = {},
): Promise<RequestedFolder> {
  const given = raw.startsWith("~/") ? `${env.home ?? homedir()}/${raw.slice(2)}` : raw;
  if (given.includes("\0") || !given.startsWith("/")) return { status: "missing" };
  let real: string;
  try {
    real = await realpath(resolve(given));
    if (!(await stat(real)).isDirectory()) return { status: "missing" };
  } catch {
    return { status: "missing" };
  }
  const protectedReal: string[] = [];
  for (const p of env.protectedRoots ?? []) {
    try {
      protectedReal.push(await realpath(p));
    } catch {
      // Not there: the written path is enough.
    }
  }
  const reason = refuseFolder(real, {
    ...env,
    protectedRoots: [...(env.protectedRoots ?? []), ...protectedReal],
  });
  return reason === undefined
    ? { status: "ok", path: real }
    : { status: "blocked", path: real, reason };
}

/** Offers only `once` when the request comes from a tainted context (security §3.6). */
export function folderScopesOffered(taint: boolean): ("once" | "always")[] {
  return taint ? ["once"] : ["once", "always"];
}

/**
 * Settings path: throws `forbidden` when a folder the owner types or picks into
 * `permissions.policy.folders` is a sensitive root. A folder that does not exist yet is judged
 * by its normalised path.
 */
export async function assertFolderGrantable(
  given: string,
  env: FolderAccessEnv = {},
): Promise<void> {
  const raw = given.startsWith("~/") ? `${env.home ?? homedir()}/${given.slice(2)}` : given;
  if (raw.includes("\0") || !raw.startsWith("/")) {
    throw new PsycheError("invalid_params", "folder grants are absolute paths");
  }
  let real = resolve(raw);
  try {
    real = await realpath(real);
  } catch {
    // Not there (yet): the normalised path is judged.
  }
  const protectedReal: string[] = [];
  for (const p of env.protectedRoots ?? []) {
    try {
      protectedReal.push(await realpath(p));
    } catch {
      // Not there: the written path is enough.
    }
  }
  const refusal = refuseFolder(real, {
    ...env,
    protectedRoots: [...(env.protectedRoots ?? []), ...protectedReal],
  });
  if (refusal !== undefined) {
    throw new PsycheError("forbidden", `${real} cannot be shared with the agent`, {
      details: { reason: refusal, path: real },
    });
  }
}
