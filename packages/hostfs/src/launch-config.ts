/**
 * Settings an app reads, and runs code from, the next time it opens a folder (#1427 review r1,
 * finding 4): Obsidian vault plugins and `community-plugins.json`, VS Code tasks and settings,
 * JetBrains run configurations, Zed tasks, direnv's `.envrc`, husky's git hooks. A write there
 * inside a shared folder is code that runs later, like a write under `.git`, so file writes there
 * are destructive and always show a card naming the path.
 */
export const LAUNCH_CONFIG_DIRS: readonly string[] = [
  ".obsidian",
  ".vscode",
  ".idea",
  ".zed",
  ".husky",
];

/** Single files with the same effect. */
export const LAUNCH_CONFIG_FILES: readonly string[] = [".envrc"];

/** A name as APFS and NTFS compare it: compatibility-normalized and case-folded. */
function fold(name: string): string {
  return name.normalize("NFKC").toLowerCase().toUpperCase().toLowerCase().normalize("NFKC");
}

/**
 * The launch-config folder or file `path` writes into (`.vscode`, `.envrc`...), or undefined.
 * Matched by whole path segments, without case: `.vscode/tasks.json` and `.VSCode/x` match,
 * `notes/vscode.md`, `.vscodeignore` and `.obsidian-backup.md` do not.
 */
export function launchConfigEntry(path: string): string | undefined {
  const segments = path.split(/[\\/]/).filter((s) => s !== "");
  const dirs = new Set(LAUNCH_CONFIG_DIRS);
  for (const [i, raw] of segments.entries()) {
    const s = fold(raw);
    if (dirs.has(s)) return s;
    if (i === segments.length - 1 && LAUNCH_CONFIG_FILES.includes(s)) return s;
  }
  return undefined;
}
