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
   * Every folder the walk listed or probed for a `.git` (`.` for the root), with who it was
   * (dev:ino) while it was read, or `""` when that changed meanwhile (#1457 review r1). A folder
   * above it swapped for a link makes the walk read a folder outside the root: a name the walk
   * reports is only the root's when its folder still is this one, at its real path. A folder
   * that changed is read again a few times (`SWAP_TRIES`, #1469 review r4); nothing in one still
   * noted `""` after that is walked or reported (#1469 review r3).
   */
  folders?: Record<string, string>;
  /**
   * Every folder that changed while the walk read it at least once, read again cleanly or not:
   * what was read of it before then may have been a folder outside the root.
   */
  swapped?: string[];
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
  const retry: PinRetry = { tries: SWAP_TRIES, seen: new Set() };
  const done = (complete: boolean): LaunchConfigScan => ({
    found,
    complete,
    ...(unreadable.length > 0 ? { unreadable } : {}),
    folders,
    ...(retry.seen.size > 0 ? { swapped: [...retry.seen].sort() } : {}),
  });
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  let dirs = 0;
  while (queue.length > 0) {
    const next = queue.shift() as { rel: string; depth: number };
    if (++dirs > maxDirs) return done(false);
    const key = next.rel === "" ? "." : next.rel;
    let entries: Dirent[] | undefined;
    try {
      entries = await listPinned(
        next.rel === "" ? root : join(root, next.rel),
        key,
        folders,
        root,
        retry,
      );
    } catch (err) {
      // Unlistable as itself: through a swapped folder, whether it was is not the root's either.
      if (denied(err) && folders[key] !== "") await unlisted(key);
      continue;
    }
    // Swapped while listed, or gone: nothing it named is the root's, so none of it is walked.
    if (entries === undefined) continue;
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
          for (const g of await nestedGits(root, rel, skip, unlisted, folders, retry)) {
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

/** Fresh tries at a folder that changed while it was read, before it is taken as swapped. */
export const SWAP_TRIES = 3;

/** Tries again at a folder that changed while read, noting each such folder in `seen`. */
export interface PinRetry {
  tries: number;
  seen: Set<string>;
}

/**
 * Lists `path` (`rel`), noting who it was in `folders` (#1457 review r1, #1469 reviews r1 to r4):
 * see `withPinned`. The listing only when it was the root's; undefined when it never was, or when
 * the folder was not there at all: then nothing it named is walked (#1469 review r3, finding 2),
 * so a folder outside the root is never walked and never spends the walk's limits.
 */
export async function listPinned(
  path: string,
  rel: string,
  folders: Record<string, string>,
  root?: string,
  retry?: PinRetry,
): Promise<Dirent[] | undefined> {
  return withPinned(path, rel, folders, root, () => readdir(path, { withFileTypes: true }), retry);
}

/**
 * Runs `inner` (a read of what is in `path`, `rel` under `root`) and notes who the folder was in
 * `folders`: the same folder before and after, and its own folder still the one pinned (or, for a
 * folder no listing named, its real path its path under the root, #1469 review r3, finding 1),
 * both before and after. Else it is noted as `""`: a folder on the way was swapped for a link,
 * what `inner` read may be outside the root, and its answer is dropped. With `retry`, it is then
 * read again, up to `retry.tries` times, each pinned afresh below its folder's pin (#1469 review
 * r4: a swap out and back must not hide what the folder holds), and noted in `retry.seen`. The
 * answer is undefined when no try was clean. A folder noted once keeps that identity for this
 * map, unless a fresh try pins it again. A folder that was not there at either look, below a
 * folder that stayed, is left unnoted and its answer dropped: it is gone, not swapped. Without
 * `openat`, a folder swapped out after the first look and back before the last one is not seen
 * (a residual).
 */
export async function withPinned<T>(
  path: string,
  rel: string,
  folders: Record<string, string>,
  root: string | undefined,
  inner: () => Promise<T>,
  retry?: PinRetry,
): Promise<T | undefined> {
  const parent =
    rel === "." || root === undefined
      ? undefined
      : rel.includes("/")
        ? rel.slice(0, rel.lastIndexOf("/"))
        : ".";
  for (let attempt = 0; ; attempt++) {
    // A fresh try knows only who the folder above is: what this one was noted as is not kept.
    const map: Record<string, string> =
      attempt === 0
        ? folders
        : parent !== undefined && folders[parent] !== undefined
          ? { [parent]: folders[parent] as string }
          : {};
    const r = await pinOnce(path, rel, parent, map, root, inner);
    if (r.state === "swapped") {
      retry?.seen.add(rel);
      folders[rel] = "";
      if (attempt < (retry?.tries ?? 0)) continue;
      return undefined;
    }
    if (attempt > 0) {
      const id = map[rel];
      if (id === undefined) delete folders[rel];
      else folders[rel] = id;
    }
    if (r.failed) throw r.error;
    return r.state === "ok" ? r.value : undefined;
  }
}

interface PinTry<T> {
  state: "ok" | "gone" | "swapped";
  value?: T;
  failed: boolean;
  error?: unknown;
}

/** One pinned read; a clean one notes the folder's identity in `map`. */
async function pinOnce<T>(
  path: string,
  rel: string,
  parent: string | undefined,
  map: Record<string, string>,
  root: string | undefined,
  inner: () => Promise<T>,
): Promise<PinTry<T>> {
  // A folder's identity; `""` for something else (a link, a file), undefined for nothing.
  const look = async (at: string) => {
    const st = await lstat(at, { bigint: true }).catch(() => undefined);
    if (st === undefined) return undefined;
    return st.isDirectory() ? `${st.dev}:${st.ino}` : "";
  };
  let realRoot: string | undefined;
  const above = async () => {
    if (parent === undefined || root === undefined) return true;
    const at = parent === "." ? root : join(root, parent);
    const pin = map[parent];
    if (pin !== undefined) return pin !== "" && (await look(at)) === pin;
    // A folder no listing named (one past the walk's limits): its real path is checked
    // instead, as `unlistedPinner` does.
    realRoot ??= await realpath(root).catch(() => undefined);
    if (realRoot === undefined) return false;
    const real = await realpath(at).catch(() => undefined);
    return real === (parent === "." ? realRoot : join(realRoot, parent));
  };
  const aboveBefore = await above();
  const was = await look(path);
  let value: T | undefined;
  let error: unknown;
  let failed = false;
  try {
    value = await inner();
  } catch (err) {
    error = err;
    failed = true;
  }
  const is = await look(path);
  const steady = aboveBefore && (await above());
  let state: PinTry<T>["state"];
  if (steady && was === undefined && is === undefined) {
    state = "gone";
  } else {
    const prev = map[rel];
    const same =
      steady &&
      was !== undefined &&
      was !== "" &&
      was === is &&
      (prev === undefined || prev === was);
    // A read that failed names nothing, but whether it did is itself telling (#1469 review r2):
    // one that failed through a folder swapped for a link (a link to nothing, to a file) is
    // noted as swapped. Only the pinned folder refusing for its mode is left unnoted.
    state = same && (!failed || denied(error)) ? "ok" : "swapped";
  }
  if (state === "ok" && !failed) map[rel] = was as string;
  return failed ? { state, failed, error } : { state, failed, value: value as T };
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
  retry: PinRetry,
): Promise<LaunchConfigFound[]> {
  const out: LaunchConfigFound[] = [];
  // Each folder probed is pinned like a listing (#1469 review r3): a folder on the way swapped
  // for a link would make the probe say whether a folder outside holds a `.git`. Its pin also
  // lets the `.git` found in it be pinned later, below a folder that was noted (finding 1).
  const probe = async (dir: string) => {
    const st = await withPinned(
      join(root, dir),
      dir,
      folders,
      root,
      () => lstat(join(root, dir, ".git")).catch(() => undefined),
      retry,
    );
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
  let entries: Dirent[] | undefined;
  try {
    entries = await listPinned(join(root, rel), rel, folders, root, retry);
  } catch (err) {
    if (denied(err) && folders[rel] !== "") await unlisted(rel);
    return out;
  }
  for (const d of (entries ?? []).slice(0, MAX_GIT_PROBES)) {
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
