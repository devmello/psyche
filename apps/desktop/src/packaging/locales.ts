import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The languages the UI ships catalogues for (packages/ui/src/i18n/messages/locales/index.ts; a
 * test keeps this list in step) plus `Base`. The packaged app keeps Chromium's and macOS's own
 * strings (spell check menus, form validation, the standard menus) for these and drops the rest
 * of the ≈ 110 locales (≈ 48 MB, docs/archive/reports/v1-bundle-size.md); anything else falls
 * back to en-US. A new catalogue adds its language here.
 */
export const SHIPPED_LOCALES = [
  "Base",
  "en",
  "ar",
  "de",
  "es",
  "fr",
  "hi",
  "it",
  "ja",
  "ko",
  "pt",
  "zh",
] as const;

/** `pt_BR.lproj` → `pt`; the grammatical-gender copies (`de_FEMININE`) are not worth their bytes. */
function keeps(dirName: string, keep: readonly string[]): boolean {
  const name = dirName.slice(0, -".lproj".length);
  if (/_(FEMININE|MASCULINE|NEUTER)$/.test(name)) return false;
  return keep.includes(name) || keep.includes(name.split("_")[0] ?? name);
}

/** Removes `*.lproj` other than `keep` (and their regional variants) from the app's and Electron Framework's Resources. */
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
      if (!name.endsWith(".lproj") || keeps(name, keep)) continue;
      rmSync(join(dir, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * Windows: Chromium's strings are `locales\<lang>.pak` next to Psyche.exe (≈ 45 MB for all of
 * them). Keeps the shipped languages and their regional variants (`pt-BR`, `zh-TW`, …); en-US is
 * Chromium's fallback and always stays.
 */
export function pruneWin32Locales(
  appRootDir: string,
  keep: readonly string[] = SHIPPED_LOCALES,
): number {
  const dir = join(appRootDir, "locales");
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".pak")) continue;
    const lang = name.slice(0, -".pak".length);
    if (lang === "en-US" || keep.includes(lang) || keep.includes(lang.split("-")[0] ?? lang))
      continue;
    rmSync(join(dir, name), { force: true });
    removed++;
  }
  return removed;
}
