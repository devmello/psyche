import { type Dirent, readdirSync, readlinkSync, realpathSync } from "node:fs";
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

export interface LaunchConfigScanLimits {
  /** Folders read at most per root (default 5 000). */
  maxDirs?: number;
  /** Folder depth below the root (default 6). */
  maxDepth?: number;
}

/** Never walked: git's own metadata (guarded on its own) and installed packages. */
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

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
        if (!d.isDirectory() || SKIPPED_DIRS.has(fold(d.name)) || next.depth + 1 > maxDepth) {
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
