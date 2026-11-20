import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { RecordingStore } from "@psyche/browser";
import type {
  MethodParams,
  MethodResult,
  StorageCategory,
  StorageCategoryId,
  StorageClearTarget,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * `storage.usage` and `storage.clearCache` (Settings > Data > Storage).
 *
 * Usage walks `$PSYCHE_HOME` without following symbolic links and sorts what it finds into
 * categories. Clearing is deliberately narrow: only the two categories Psyche can rebuild or that
 * expire anyway, each emptied by name from a fixed path under the home. The database, memory,
 * Library, vault, browser profiles, backups and logs have no path to this code.
 */

/** Finished recordings older than this are cleared (the same 7 days as the boot-time retention). */
export const RECORDING_CLEAR_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const CLEARABLE: ReadonlySet<StorageCategoryId> = new Set(["caches", "recordings"]);

/** Bytes under `path` (a file or a folder), links counted as themselves and never followed. */
export async function sizeOf(path: string): Promise<number> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) total += await sizeOf(join(path, name));
  return total;
}

/** Sizes of the files in `dir` whose names start with one of `prefixes` (SQLite adds -wal, -shm). */
async function sizeOfFiles(dir: string, prefixes: readonly string[]): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    if (prefixes.some((p) => name === p || name.startsWith(`${p}-`))) {
      total += await sizeOf(join(dir, name));
    }
  }
  return total;
}

export async function storageUsage(home: string): Promise<MethodResult<"storage.usage">> {
  const state = join(home, "state");
  const recordings = await sizeOf(join(home, "library", "recordings"));
  const sizes: Record<Exclude<StorageCategoryId, "other">, number> = {
    database: await sizeOfFiles(state, ["psyche.sqlite"]),
    memoryIndex: await sizeOfFiles(state, ["memory.sqlite", "search.sqlite"]),
    library: Math.max(0, (await sizeOf(join(home, "library"))) - recordings),
    browserProfiles: await sizeOf(join(home, "browser")),
    recordings,
    logs: await sizeOf(join(home, "logs")),
    caches: await sizeOf(join(home, "cache")),
  };
  const total = await sizeOf(home);
  const known = Object.values(sizes).reduce((a, b) => a + b, 0);
  const all: Record<StorageCategoryId, number> = { ...sizes, other: Math.max(0, total - known) };
  const categories: StorageCategory[] = (Object.keys(all) as StorageCategoryId[]).map((id) => ({
    id,
    bytes: all[id],
    clearable: CLEARABLE.has(id),
  }));
  return { categories, totalBytes: categories.reduce((a, c) => a + c.bytes, 0) };
}

/** Empties `dir` but keeps the folder; refuses a link in its place. */
async function emptyFolder(dir: string): Promise<void> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(dir);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of await readdir(dir)) {
    await rm(join(dir, name), { recursive: true, force: true });
  }
}

export async function clearStorage(
  home: string,
  targets: readonly StorageClearTarget[],
  now = Date.now(),
): Promise<MethodResult<"storage.clearCache">> {
  const wanted = new Set(targets.filter((t) => CLEARABLE.has(t)));
  const before = await storageUsage(home);
  const cleared: StorageClearTarget[] = [];
  if (wanted.has("caches")) {
    await emptyFolder(join(home, "cache"));
    cleared.push("caches");
  }
  if (wanted.has("recordings")) {
    // Finished recordings only: one still being written has no end time and is skipped.
    await new RecordingStore(join(home, "library", "recordings")).prune(
      RECORDING_CLEAR_AGE_MS,
      now,
    );
    cleared.push("recordings");
  }
  const after = await storageUsage(home);
  return { cleared, freedBytes: Math.max(0, before.totalBytes - after.totalBytes) };
}

export function composeStorage(services: ComposeServices): ComposedPart {
  const { home } = services;
  let clearing = false;
  const handlers: Record<string, HandlerDef> = {
    "storage.usage": { run: () => storageUsage(home) },
    "storage.clearCache": {
      run: async (_call: Call, params: MethodParams<"storage.clearCache">) => {
        if (clearing) return { cleared: [], freedBytes: 0 };
        clearing = true;
        try {
          const result = await clearStorage(home, params.targets ?? ["caches", "recordings"]);
          services.logger?.log("info", "storage cleared", {
            cleared: result.cleared.join(","),
            freedBytes: result.freedBytes,
          });
          return result;
        } finally {
          clearing = false;
        }
      },
    },
  };
  return { handlers };
}
