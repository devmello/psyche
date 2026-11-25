import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { RecordingStore } from "@psyche/browser";
import type { PsycheDb } from "@psyche/db";
import type {
  MethodParams,
  MethodResult,
  StorageCategory,
  StorageCategoryId,
  StorageClearTarget,
} from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { compactDatabase, compactEstimate } from "../db-maintenance.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * `storage.usage` and `storage.clearCache` (Settings > Data > Storage).
 *
 * Usage is one walk of `$PSYCHE_HOME` that sorts every file by its top-level folder, without
 * following symbolic links, shared between concurrent callers and capped in entries and time (a
 * capped walk reports lower bounds). Clearing is deliberately narrow: only the two categories
 * Psyche can rebuild or that expire anyway, each at a fixed path under the home. The database,
 * memory, the rest of the Library, vault, browser profiles, backups and logs have no path to this
 * code.
 */

/** Finished recordings older than this are cleared (the same 7 days as the boot-time retention). */
export const RECORDING_CLEAR_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A walk stops after this many entries or this long and reports what it has. */
export const WALK_MAX_ENTRIES = 400_000;
export const WALK_MAX_MS = 8_000;

const CLEARABLE: ReadonlySet<StorageCategoryId> = new Set(["caches", "recordings"]);

type Stat = Awaited<ReturnType<typeof lstat>>;

/** Disk bytes of one entry: allocated blocks when known (sparse files), else the size. */
const diskBytes = (st: Stat): number =>
  typeof st.blocks === "number" && st.blocks > 0 ? st.blocks * 512 : Number(st.size);

interface Walk {
  entries: number;
  startedAt: number;
  partial: boolean;
}

const newWalk = (): Walk => ({ entries: 0, startedAt: Date.now(), partial: false });

/** Bytes under `path` (a file or a folder), links counted as themselves and never followed. */
async function walkSize(path: string, walk: Walk, onFile?: (rel: string, bytes: number) => void) {
  const stack: { path: string; rel: string }[] = [{ path, rel: "" }];
  let total = 0;
  while (stack.length > 0) {
    const cur = stack.pop() as { path: string; rel: string };
    if (walk.entries >= WALK_MAX_ENTRIES || Date.now() - walk.startedAt > WALK_MAX_MS) {
      walk.partial = true;
      break;
    }
    walk.entries++;
    let st: Stat;
    try {
      st = await lstat(cur.path);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      const n = diskBytes(st);
      total += n;
      onFile?.(cur.rel, n);
      continue;
    }
    // A directory's own block counts too.
    total += diskBytes(st);
    onFile?.(cur.rel, diskBytes(st));
    let names: string[];
    try {
      names = await readdir(cur.path);
    } catch {
      continue;
    }
    for (const name of names) {
      stack.push({ path: join(cur.path, name), rel: cur.rel === "" ? name : `${cur.rel}/${name}` });
    }
  }
  return total;
}

/** Bytes under `path`, no cap. */
export async function sizeOf(path: string): Promise<number> {
  return walkSize(path, { entries: 0, startedAt: Date.now() + 3_600_000, partial: false });
}

const STATE_DB = ["psyche.sqlite"];
const STATE_MEMORY = ["memory.sqlite", "search.sqlite"];
const inState = (name: string, prefixes: readonly string[]): boolean =>
  prefixes.some((p) => name === p || name.startsWith(`${p}-`));

/** The category of a path relative to the home. */
export function categoryOf(rel: string): StorageCategoryId {
  const [top = "", second = ""] = rel.split("/");
  if (top === "state") {
    if (inState(second, STATE_DB)) return "database";
    if (inState(second, STATE_MEMORY)) return "memoryIndex";
    return "other";
  }
  if (top === "library") return second === "recordings" ? "recordings" : "library";
  if (top === "browser") return "browserProfiles";
  if (top === "logs") return "logs";
  if (top === "cache") return "caches";
  return "other";
}

/** The folder name of a recording id (the same mapping the recorder uses). */
const recordingDirOf = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "_");
/** `recordings/<dir>` as the Library stores it. */
const recordingLibraryPath = (id: string): string => `recordings/${recordingDirOf(id)}`;

/** Finished recordings older than the clear age, with the bytes each takes. */
async function oldRecordings(home: string, now: number): Promise<{ id: string; bytes: number }[]> {
  const dir = join(home, "library", "recordings");
  const store = new RecordingStore(dir);
  const out: { id: string; bytes: number }[] = [];
  for (const r of await store.list().catch(() => [])) {
    if (typeof r.endedAt !== "string" || now - Date.parse(r.endedAt) <= RECORDING_CLEAR_AGE_MS) {
      continue;
    }
    out.push({ id: r.id, bytes: await sizeOf(join(dir, recordingDirOf(r.id))) });
  }
  return out;
}

const inflight = new Map<string, Promise<MethodResult<"storage.usage">>>();

export function storageUsage(
  home: string,
  now = Date.now(),
): Promise<MethodResult<"storage.usage">> {
  const running = inflight.get(home);
  if (running) return running;
  const p = computeUsage(home, now).finally(() => inflight.delete(home));
  inflight.set(home, p);
  return p;
}

async function computeUsage(home: string, now: number): Promise<MethodResult<"storage.usage">> {
  const bytes: Record<StorageCategoryId, number> = {
    database: 0,
    memoryIndex: 0,
    library: 0,
    browserProfiles: 0,
    recordings: 0,
    logs: 0,
    caches: 0,
    other: 0,
  };
  const walk = newWalk();
  await walkSize(home, walk, (rel, n) => {
    if (rel !== "") bytes[categoryOf(rel)] += n;
  });
  const reclaimable: Partial<Record<StorageCategoryId, number>> = {
    caches: bytes.caches,
    recordings: (await oldRecordings(home, now)).reduce((a, r) => a + r.bytes, 0),
  };
  const categories: StorageCategory[] = (Object.keys(bytes) as StorageCategoryId[]).map((id) => ({
    id,
    bytes: bytes[id],
    clearable: CLEARABLE.has(id),
    ...(CLEARABLE.has(id) ? { reclaimableBytes: reclaimable[id] ?? 0 } : {}),
  }));
  return {
    categories,
    totalBytes: categories.reduce((a, c) => a + c.bytes, 0),
    ...(walk.partial ? { partial: true } : {}),
  };
}

/**
 * Empties `cache/` and returns the bytes freed. The folder is renamed away first (a rename acts
 * on a link itself, never its target), the renamed entry must be a real directory, and only then
 * is a fresh `cache/` made (0700) and the old one deleted. Anything else is put back untouched.
 */
export async function clearCacheFolder(home: string): Promise<number> {
  const dir = join(home, "cache");
  try {
    await lstat(dir);
  } catch {
    return 0;
  }
  const trash = join(home, `.cache-clearing-${randomUUID()}`);
  await rename(dir, trash);
  const st = await lstat(trash);
  if (!st.isDirectory()) {
    await rename(trash, dir);
    return 0;
  }
  await mkdir(dir, { mode: 0o700 });
  const freed = await sizeOf(trash);
  await rm(trash, { recursive: true, force: true });
  return freed;
}

export async function clearStorage(
  home: string,
  targets: readonly StorageClearTarget[],
  now = Date.now(),
  db?: PsycheDb,
  /** Called with the id of each Library row removed, so clients drop it (`library.item.changed`). */
  onLibraryRemoved?: (itemId: string) => void,
): Promise<MethodResult<"storage.clearCache">> {
  const wanted = new Set(targets.filter((t) => CLEARABLE.has(t)));
  const cleared: StorageClearTarget[] = [];
  let freedBytes = 0;
  if (wanted.has("caches")) {
    freedBytes += await clearCacheFolder(home);
    cleared.push("caches");
  }
  if (wanted.has("recordings")) {
    // Finished recordings only: one still being written has no end time and is skipped.
    const old = await oldRecordings(home, now);
    const removed = await new RecordingStore(join(home, "library", "recordings")).prune(
      RECORDING_CLEAR_AGE_MS,
      now,
    );
    const gone = new Set(removed);
    for (const r of old) {
      if (!gone.has(r.id)) continue;
      freedBytes += r.bytes;
      // The Library row of a recording whose folder is gone would dangle.
      if (db === undefined) continue;
      const path = recordingLibraryPath(r.id);
      const rows = db.sqlite
        .prepare("SELECT id FROM library_items WHERE kind = 'recording' AND path = ?")
        .all(path) as { id: string }[] | undefined;
      db.sqlite
        .prepare("DELETE FROM library_items WHERE kind = 'recording' AND path = ?")
        .run(path);
      for (const row of rows ?? []) onLibraryRemoved?.(row.id);
    }
    cleared.push("recordings");
  }
  return { cleared, freedBytes };
}

export function composeStorage(services: ComposeServices): ComposedPart {
  const { home } = services;
  let clearing = false;
  const handlers: Record<string, HandlerDef> = {
    "storage.usage": { run: () => storageUsage(home) },
    "storage.compactEstimate": {
      run: () => {
        if (services.db === undefined) return { dbBytes: 0, reclaimableBytes: 0, idle: false };
        return compactEstimate(services.db);
      },
    },
    "storage.compact": {
      run: () => {
        if (services.db === undefined) {
          throw new PsycheError("unavailable", "The database is not available.");
        }
        const log = services.logger ?? { log: () => {} };
        const r = compactDatabase({ db: services.db, log });
        if (!r.ok) {
          throw new PsycheError(
            "conflict",
            r.reason === "busy"
              ? "Psyche is working on something. Compact the database when it has finished."
              : r.reason === "disk"
                ? "There isn't enough free disk space to compact the database."
                : "This database cannot be compacted.",
          );
        }
        return { durationMs: r.ms, savedBytes: r.savedBytes };
      },
    },
    "storage.clearCache": {
      run: async (call: Call, params: MethodParams<"storage.clearCache">) => {
        if (clearing) return { cleared: [], freedBytes: 0 };
        clearing = true;
        try {
          const result = await clearStorage(
            home,
            params.targets ?? ["caches", "recordings"],
            Date.now(),
            services.db,
            (itemId) => call.emit("library.item.changed", { itemId, change: "deleted" }),
          );
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
