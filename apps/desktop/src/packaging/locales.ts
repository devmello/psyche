import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The UI is English only, so the packaged app ships Chromium's English locale and drops the other
 * 109 (≈ 48 MB, reports/v1-bundle-size.md). macOS then offers the app in English only, and Chromium
 * falls back to en-US for its own strings (spell check menus, form validation messages). A
 * translated UI adds its locales here.
 */
export const SHIPPED_LOCALES = ["en", "Base"] as const;

/** Removes `*.lproj` other than `keep` from the app's and Electron Framework's Resources. */
export function pruneLocales(
  contentsDir: string,
  keep: readonly string[] = SHIPPED_LOCALES,
): number {
  const dirs = [
    join(contentsDir, "Resources"),
    join(contentsDir, "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources"),
  ];
  let removed = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".lproj") || keep.includes(name.slice(0, -".lproj".length))) continue;
      rmSync(join(dir, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
