import { type Dirent, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";

/**
 * Settings an app reads, and runs code from, the next time it opens a folder (#1427 review r1,
 * finding 4; #1434 review r1, finding 2): Obsidian vault plugins and `community-plugins.json`,
 * VS Code tasks and settings, JetBrains run configurations, Zed tasks, dev containers
 * (`initializeCommand` runs on the host), husky's git hooks. A write there inside a shared
 * folder is code that runs later, like a write under `.git`, so file writes there are
 * destructive and always show a card naming the path.
 */
export const LAUNCH_CONFIG_DIRS: readonly string[] = [
  ".obsidian",
  ".vscode",
  ".idea",
  ".zed",
  ".husky",
  ".devcontainer",
];

/**
 * Single files with the same effect: read when an editor or agent opens the folder (direnv,
 * MCP server lists, Neovim and Vim local config), or by the next command run there (pre-commit
 * and lefthook hooks, `yarnPath`, npm's `node-options`, pnpm hooks).
 */
export const LAUNCH_CONFIG_FILES: readonly string[] = [
  ".envrc",
  ".mcp.json",
  ".nvim.lua",
  ".exrc",
  ".pre-commit-config.yaml",
  "lefthook.yml",
  "lefthook.yaml",
  ".yarnrc.yml",
  ".npmrc",
  ".pnpmfile.cjs",
];

/** Files that count only in a given folder: `[folder, test on the file name]`. */
const LAUNCH_CONFIG_PAIRS: readonly (readonly [string, (name: string) => boolean])[] = [
  // Claude Code hooks, in a folder the owner trusts.
  [".claude", (n) => /^settings.*\.json$/.test(n)],
  [".cursor", (n) => n === "mcp.json"],
  // `rustc-wrapper`, `runner`... (`config` is the older name Cargo still reads).
  [".cargo", (n) => n === "config.toml" || n === "config"],
];

/** VS Code workspace files (`app.code-workspace`): tasks and settings, like `.vscode`. */
const WORKSPACE_SUFFIX = ".code-workspace";

/** A name as APFS and NTFS compare it: compatibility-normalized and case-folded. */
function fold(name: string): string {
  return name.normalize("NFKC").toLowerCase().toUpperCase().toLowerCase().normalize("NFKC");
}

/**
 * The launch-config folder or file `path` writes into (`.vscode`, `.envrc`,
 * `.cursor/mcp.json`...), or undefined. Matched by whole path segments, without case:
 * `.vscode/tasks.json` and `.VSCode/x` match, `notes/vscode.md`, `.vscodeignore`,
 * `.npmrc.example` and `my.code-workspace.md` do not.
 */
export function launchConfigEntry(path: string): string | undefined {
  const segments = path
    .split(/[\\/]/)
    .filter((s) => s !== "")
    .map(fold);
  const dirs = new Set(LAUNCH_CONFIG_DIRS);
  const last = segments.length - 1;
  for (const [i, s] of segments.entries()) {
    if (dirs.has(s)) return s;
    if (i !== last) continue;
    if (LAUNCH_CONFIG_FILES.includes(s)) return s;
    if (s.endsWith(WORKSPACE_SUFFIX) && s.length > WORKSPACE_SUFFIX.length) return s;
    const parent = segments[i - 1];
    if (parent !== undefined && LAUNCH_CONFIG_PAIRS.some(([d, test]) => d === parent && test(s))) {
      return `${parent}/${s}`;
    }
  }
  return undefined;
}

/** One launch-config entry found in a folder tree, relative to its root (`/`-separated). */
export interface LaunchConfigFound {
  rel: string;
  kind: "dir" | "file" | "link" | "other";
  /** A link's own target, as written. */
  linkTarget?: string;
  /** A nested repository's own git folder (`vendor/lib/.git`), with `nestedGit`. */
  git?: true;
}

export interface LaunchConfigScan {
  found: LaunchConfigFound[];
  /** False when a limit stopped the walk: what was not walked was not checked. */
  complete: boolean;
  /**
   * Folders the walk could not list (no read or search permission), when there are any. A
   * search-only folder still lets an app open a launch-config file in it by name.
   */
  unreadable?: LaunchConfigUnlisted[];
  /**
   * Every folder the walk listed (`.` for the root), with who it was (dev:ino) while it was
   * listed, or `""` when that changed during the listing (#1457 review r1). A folder above it
   * swapped for a link makes the walk list a folder outside the root: a name the walk reports
   * is only the root's when its folder still is this one, at its real path.
   */
  folders?: Record<string, string>;
}

/** A folder the walk could not list. */
export interface LaunchConfigUnlisted {
  rel: string;
  /**
   * Who it was (dev:ino), taken before a check that it was inside the root then: what is at its
   * path later and is not this is something else (#1450 review r2). Unset when that check failed.
   */
  id?: string;
}

export interface LaunchConfigScanLimits {
  /** Folders read at most (default 20 000). */
  maxDirs?: number;
  /** Entries returned at most (default 64). */
  maxFound?: number;
  /**
   * Folder depth below the root (default unlimited). Deeper folders are not walked, and that
   * alone does not make the scan incomplete: a depth is a choice, the other limits are not.
   */
  maxDepth?: number;
  /**
   * Also report each `.git` below the root (a vendored clone's own repository), as an entry
   * with `git: true`. It is never walked either.
   */
  nestedGit?: boolean;
}

/**
 * Never walked: git's own metadata (guarded on its own), installed packages, and build and
 * cache output. Launchers read their config at the folders the owner opens, never in these.
 */
export const LAUNCH_SCAN_SKIPPED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "target",
  ".build",
  "build",
  "dist",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "deriveddata",
  "pods",
  ".gradle",
  ".cache",
]);

/** Folders never walked by their path from the root: agent worktrees are checkouts of their own. */
const SKIPPED_PATHS = new Set([".claude/worktrees"]);

function skipped(rel: string, name: string): boolean {
  return (
    LAUNCH_SCAN_SKIPPED_DIRS.has(fold(name)) ||
    SKIPPED_PATHS.has(rel.split("/").map(fold).join("/"))
  );
}

function kindOf(d: Dirent): LaunchConfigFound["kind"] {
  if (d.isSymbolicLink()) return "link";
  if (d.isDirectory()) return "dir";
  if (d.isFile()) return "file";
  return "other";
}

/**
 * Every launch-config entry under `root`, without following links (a link named `.obsidian` is
 * reported as a link, never walked) and without walking into an entry or a skipped folder
 * (`LAUNCH_SCAN_SKIPPED_DIRS`, `.claude/worktrees`). Bounded by `limits`.
 */
export async function findLaunchConfig(
  root: string,
  limits: LaunchConfigScanLimits = {},
): Promise<LaunchConfigScan> {
  const maxDirs = limits.maxDirs ?? 20_000;
  const maxFound = limits.maxFound ?? 64;
  const maxDepth = limits.maxDepth ?? Number.POSITIVE_INFINITY;
  const found: LaunchConfigFound[] = [];
  const unreadable: LaunchConfigUnlisted[] = [];
  const unlisted = unlistedPinner(root, unreadable);
  const folders: Record<string, string> = {};
  const done = (complete: boolean): LaunchConfigScan =>
    unreadable.length > 0 ? { found, complete, unreadable, folders } : { found, complete, folders };
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  let dirs = 0;
  while (queue.length > 0) {
    const next = queue.shift() as { rel: string; depth: number };
    if (++dirs > maxDirs) return done(false);
    let entries: Dirent[];
    try {
      entries = await listPinned(
        next.rel === "" ? root : join(root, next.rel),
        next.rel === "" ? "." : next.rel,
        folders,
        root,
      );
    } catch (err) {
      if (denied(err)) await unlisted(next.rel === "" ? "." : next.rel);
      continue;
    }
    for (const d of entries) {
      const rel = next.rel === "" ? d.name : `${next.rel}/${d.name}`;
      const kind = kindOf(d);
      if (limits.nestedGit === true && next.rel !== "" && fold(d.name) === ".git") {
        if (found.length >= maxFound) return done(false);
        found.push({ rel, kind, git: true });
        continue;
      }
      if (launchConfigEntry(rel) !== undefined) {
        if (found.length >= maxFound) return done(false);
        const linkTarget =
          kind === "link" ? await readlink(join(root, rel)).catch(() => undefined) : undefined;
        found.push({ rel, kind, ...(linkTarget === undefined ? {} : { linkTarget }) });
        continue;
      }
      if (kind !== "dir") continue;
      const skip = skipped(rel, d.name);
      if (skip || next.depth + 1 > maxDepth) {
        // A folder not walked can still hold a repository an editor finds and runs git in
        // (VS Code looks one and two levels down, in build output too): looked for directly.
        if (limits.nestedGit === true && fold(d.name) !== "node_modules") {
          for (const g of await nestedGits(root, rel, skip, unlisted, folders)) {
            if (found.length >= maxFound) return done(false);
            found.push(g);
          }
        }
        continue;
      }
      queue.push({ rel, depth: next.depth + 1 });
    }
  }
  return done(true);
}

const denied = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
};

/**
 * Records an unlisted folder with its identity: taken first, then the folder's real path is
 * checked to be its path under the root, so a folder above it swapped for a link before the
 * identity was taken is caught by the check, and one swapped after by the identity.
 */
function unlistedPinner(root: string, into: LaunchConfigUnlisted[]) {
  let realRoot: Promise<string | undefined> | undefined;
  return async (rel: string): Promise<void> => {
    const path = rel === "." ? root : join(root, rel);
    const st = await lstat(path, { bigint: true }).catch(() => undefined);
    realRoot ??= realpath(root).catch(() => undefined);
    const base = await realRoot;
    const real = await realpath(path).catch(() => undefined);
    const inside =
      base !== undefined && real === (rel === "." ? base : join(base, rel)) && st?.isDirectory();
    into.push(inside === true && st !== undefined ? { rel, id: `${st.dev}:${st.ino}` } : { rel });
  };
}

/**
 * Lists `path` (`rel`), noting who it was: the same folder before and after the listing, and its
 * folder (listed before it, top down) still the one that was listed, at the same path. Else it
 * is noted as `""`: a folder on the way was swapped for a link, the listing may be of a folder
 * outside the root, and nothing it named is reported as the root's.
 */
async function listPinned(
  path: string,
  rel: string,
  folders: Record<string, string>,
  root?: string,
): Promise<Dirent[]> {
  const id = async (at: string) => {
    const st = await lstat(at, { bigint: true }).catch(() => undefined);
    return st?.isDirectory() === true ? `${st.dev}:${st.ino}` : "";
  };
  const was = await id(path);
  const entries = await readdir(path, { withFileTypes: true });
  const is = await id(path);
  let above = true;
  if (rel !== "." && root !== undefined) {
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
    const pin = folders[parent];
    above =
      pin !== undefined &&
      pin !== "" &&
      (await id(parent === "." ? root : join(root, parent))) === pin;
  }
  folders[rel] = was !== "" && was === is && above ? was : "";
  return entries;
}

/** Folders below an unwalked one checked for their own `.git` at most. */
const MAX_GIT_PROBES = 2_000;

/**
 * `<rel>/.git`, and with `children` each `<rel>/<child>/.git`, for a folder the walk does not go
 * into. Plain `lstat`s and one listing, never a walk.
 */
async function nestedGits(
  root: string,
  rel: string,
  children: boolean,
  unlisted: (rel: string) => Promise<void>,
  folders: Record<string, string>,
): Promise<LaunchConfigFound[]> {
  const out: LaunchConfigFound[] = [];
  const probe = async (dir: string) => {
    const st = await lstat(join(root, dir, ".git")).catch(() => undefined);
    if (st === undefined) return;
    const kind = st.isSymbolicLink()
      ? "link"
      : st.isDirectory()
        ? "dir"
        : st.isFile()
          ? "file"
          : "other";
    out.push({ rel: `${dir}/.git`, kind, git: true });
  };
  await probe(rel);
  if (!children) return out;
  let entries: Dirent[];
  try {
    entries = await listPinned(join(root, rel), rel, folders, root);
  } catch (err) {
    if (denied(err)) await unlisted(rel);
    return out;
  }
  for (const d of entries.slice(0, MAX_GIT_PROBES)) {
    if (d.isDirectory() && fold(d.name) !== ".git") await probe(`${rel}/${d.name}`);
  }
  return out;
}

/**
 * The real paths symlinked launch-config entries under `roots` point at (#1434 review r1,
 * finding 3): `Vault/.obsidian -> ~/dotfiles/obsidian` makes every write under
 * `~/dotfiles/obsidian` a write into the vault's Obsidian config. A synchronous, bounded walk
 * (it runs while a call is described); what a limit leaves unwalked is not reported.
 */
export function launchConfigLinkTargets(
  roots: readonly string[],
  limits: LaunchConfigScanLimits = {},
): string[] {
  const maxDirs = limits.maxDirs ?? 5_000;
  const maxDepth = limits.maxDepth ?? 6;
  const out = new Set<string>();
  for (const root of roots) {
    const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
    let dirs = 0;
    while (queue.length > 0 && ++dirs <= maxDirs) {
      const next = queue.shift() as { dir: string; depth: number };
      let entries: Dirent[];
      try {
        entries = readdirSync(next.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of entries) {
        const path = join(next.dir, d.name);
        if (launchConfigEntry(d.name) !== undefined || launchPair(next.dir, d.name)) {
          if (!d.isSymbolicLink()) continue;
          try {
            readlinkSync(path);
            out.add(realpathSync.native(path));
          } catch {
            // A dangling link points nowhere a write could reach through it.
          }
          continue;
        }
        if (
          !d.isDirectory() ||
          LAUNCH_SCAN_SKIPPED_DIRS.has(fold(d.name)) ||
          next.depth + 1 > maxDepth
        ) {
          continue;
        }
        queue.push({ dir: path, depth: next.depth + 1 });
      }
    }
  }
  return [...out];
}

/** A two-segment entry (`.cursor/mcp.json`) named by its folder and file name. */
function launchPair(dir: string, name: string): boolean {
  const parent = dir.split(/[\\/]/).pop() ?? "";
  return launchConfigEntry(`${parent}/${name}`)?.includes("/") === true;
}
