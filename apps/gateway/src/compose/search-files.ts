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
import { type FilesOcr, type FilesSourceDeps, filesAdapter, type PowerState } from "@psyche/search";
import { readWindowsPower, type WindowsPower } from "../platform.ts";

export { filesAdapter };

/** The files source over the granted folders, with the files package's extractors (PDF, DOCX, XLSX). */
export function filesSourceDeps(o: {
  folders: () => readonly GrantedFolder[];
  protectedRoots?: () => readonly string[] | undefined;
  /** Vision OCR through the Mac helper; the owner's switch is added by the search compose. */
  ocr?: Omit<FilesOcr, "enabled">;
}): FilesSourceDeps {
  return {
    folders: o.folders,
    // Off until composeSearch binds the owner's switch (a bare `ocr` would be always on).
    ...(o.ocr === undefined ? {} : { ocr: { ...o.ocr, enabled: () => false } }),
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

/** Reads the power state: cached for owner-paced work, `fresh()` when an owner action asks. */
export type PowerRead = (() => PowerState) & { fresh: () => Promise<PowerState> };

/** Windows `GetSystemPowerStatus` → battery state: a PC with no battery is never on battery. */
export function windowsPowerState(p: WindowsPower | undefined): PowerState {
  if (p === undefined) return { onBattery: false, lowPower: false };
  return { onBattery: !p.noBattery && p.onAc === false, lowPower: p.saver };
}

/**
 * Battery state, cached for a minute: on macOS from two short-lived `pmset` calls, on Windows from
 * one PowerShell read of `GetSystemPowerStatus` (battery saver is "low power"); plugged in
 * everywhere else and when the read fails (unknown means "do the work"). The cached read answers
 * from the last reading and refreshes in the background, so after a long idle it can be stale
 * (still "battery" after plugging in): an owner's Rebuild calls `fresh()` first (2026-11-03).
 */
export function powerReader(
  platform: string = process.platform,
  ttlMs = 60_000,
  windowsRead: () => Promise<WindowsPower | undefined> = () => readWindowsPower(),
): PowerRead {
  let cached: { at: number; state: PowerState } | undefined;
  let inflight: Promise<PowerState> | undefined;
  const run = (args: string[]) =>
    new Promise<string>((resolve) =>
      execFile("/usr/bin/pmset", args, { timeout: 3000 }, (_e, out) => resolve(out ?? "")),
    );
  const measured = platform === "darwin" || platform === "win32";
  const readNow = (): Promise<PowerState> =>
    platform === "win32"
      ? windowsRead().then(windowsPowerState, () => windowsPowerState(undefined))
      : Promise.all([run(["-g", "batt"]), run(["-g"])]).then(([b, s]) => parsePower(b, s));
  const refresh = (): Promise<PowerState> => {
    inflight ??= readNow().then((state) => {
      cached = { at: Date.now(), state };
      inflight = undefined;
      return state;
    });
    return inflight;
  };
  const read = (): PowerState => {
    if (!measured) return { onBattery: false, lowPower: false };
    if (cached === undefined || Date.now() - cached.at > ttlMs) void refresh();
    return cached?.state ?? { onBattery: false, lowPower: false };
  };
  return Object.assign(read, {
    fresh: async (): Promise<PowerState> =>
      !measured ? { onBattery: false, lowPower: false } : refresh(),
  });
}
