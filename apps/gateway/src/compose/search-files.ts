import { execFile } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  assertNotProtected,
  documentFormatOf,
  EXTRACT_LIMITS,
  extractDocument,
  type GrantedFolder,
} from "@psyche/files";
import { type FilesSourceDeps, filesAdapter, type PowerState } from "@psyche/search";

export { filesAdapter };

/** The files source over the granted folders, with the files package's extractors (PDF, DOCX, XLSX). */
export function filesSourceDeps(o: {
  folders: () => readonly GrantedFolder[];
  protectedRoots?: () => readonly string[] | undefined;
}): FilesSourceDeps {
  return {
    folders: o.folders,
    isProtected: (path) => {
      try {
        assertNotProtected(path, o.protectedRoots?.());
        return false;
      } catch {
        return true;
      }
    },
    async extractDocument(path, signal) {
      const format = documentFormatOf(path);
      if (format === undefined) return undefined;
      const bytes = await readFile(path);
      if (bytes.length > EXTRACT_LIMITS.fileBytes) return "";
      let text = "";
      let offset = 0;
      for (let i = 0; i < 40 && text.length < 200_000; i++) {
        const page = await extractDocument(format, bytes, { offset, signal });
        text += `${page.text}\n`;
        if (page.nextOffset === undefined) break;
        offset = page.nextOffset;
      }
      return text;
    },
  };
}

/**
 * One FSEvents stream per granted root (`fs.watch` recursive uses FSEvents on macOS), coalesced:
 * `onChange` fires once, 2 s after the last event. Roots that cannot be watched are skipped (the
 * nightly sweep still catches their changes).
 */
export function watchFolders(roots: readonly string[], onChange: () => void): () => void {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(onChange, 2000);
    timer.unref?.();
  };
  for (const root of roots) {
    try {
      const w = watch(root, { recursive: true, persistent: false }, fire);
      w.on("error", () => undefined);
      watchers.push(w);
    } catch {
      // Not watchable: the sweep covers it.
    }
  }
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}

/** `pmset -g batt` / `pmset -g` → battery state (pure, for tests). */
export function parsePower(batt: string, settings: string): PowerState {
  return {
    // A character class keeps `from '…'` out of build-psyched's import scan.
    onBattery: /Now drawing from ['"]Battery Power['"]/.test(batt),
    lowPower: /^\s*lowpowermode\s+1\s*$/m.test(settings),
  };
}

/**
 * Battery state on macOS from two short-lived `pmset` calls, cached for a minute; plugged in
 * everywhere else and when `pmset` fails (unknown means "do the work").
 */
export function powerReader(platform: string = process.platform, ttlMs = 60_000) {
  let cached: { at: number; state: PowerState } | undefined;
  let refreshing = false;
  const run = (args: string[]) =>
    new Promise<string>((resolve) =>
      execFile("/usr/bin/pmset", args, { timeout: 3000 }, (_e, out) => resolve(out ?? "")),
    );
  return (): PowerState => {
    if (platform !== "darwin") return { onBattery: false, lowPower: false };
    const t = Date.now();
    if ((cached === undefined || t - cached.at > ttlMs) && !refreshing) {
      refreshing = true;
      void Promise.all([run(["-g", "batt"]), run(["-g"])]).then(([b, s]) => {
        cached = { at: Date.now(), state: parsePower(b, s) };
        refreshing = false;
      });
    }
    return cached?.state ?? { onBattery: false, lowPower: false };
  };
}
