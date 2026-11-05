import { lstat, readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { getSetting, type PsycheDb } from "@psyche/db";
import { assertNotProtected } from "@psyche/files";
import {
  assignProjects,
  type CalendarEventRecord,
  type FileChangeRecord,
  type FolderRecord,
  type GraphStore,
  normalizeName,
  type ReminderRecord,
  runWorkSignals,
  type WorkSettings,
  type WorkSignalReport,
} from "@psyche/memory";
import { type Clock, MEMORY_WORK_SETTING_KEY } from "@psyche/protocol";
import type { People } from "./people.ts";
import type { AppleSearchSeams } from "./search-apple.ts";
import type { ComposedPart } from "./services.ts";

/**
 * Work signals in the Gateway (docs/design/memory-everything-2026.md §3, MW3): reads the owner's
 * tracked Reminders lists, owner calendars, anchored folders and (through the graph) sent mail,
 * and hands them to `runWorkSignals`, which decides everything by rules. No model. Nothing runs
 * until the owner has turned work tracking on and seen the consent card (`memory.work.enabled`
 * and `consentedAt`); the list-to-course map and the folder rule are owner settings
 * (`operator.admin`), so nothing the extractor reads can change them (W6).
 *
 * Trust is decided here, from the connector's own check (#1006): a Reminders row or an event is
 * `trusted` only when it is the owner's own content on a source they declared theirs. A folder
 * counts only when it sits inside a granted folder. Everything else still arrives, flagged
 * untrusted, so the rules can offer a suggestion and never change state.
 */

const PASS_MS = 15 * 60_000;
const FIRST_PASS_MS = 90_000;
const DAY_MS = 86_400_000;
/** Calendar window: the recent past (due dates and meetings) and a term ahead. */
const EVENTS_BACK_DAYS = 14;
const EVENTS_AHEAD_DAYS = 120;
/** First file sweep looks this far back; later ones continue from the last. */
const FILES_FIRST_DAYS = 7;
const FILES_CURSOR = "work:files";
/** Bounds on a sweep: it reads names and times only, never contents. */
const MAX_ENTRIES_PER_ROOT = 5000;
const MAX_DEPTH = 8;
const MAX_FOLDERS = 400;
const SKIP_DIRS = new Set(["node_modules", ".git", "Library", ".Trash"]);

// --- settings --------------------------------------------------------------------------------

export interface WorkComposeSettings extends WorkSettings {
  /** On and consented: the switch is on and the owner has seen the consent card. */
  enabled: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Off by default, and off until the owner has consented; a bad value reads as the default. */
export function workSettings(value: unknown): WorkComposeSettings {
  const o = isObj(value) ? value : {};
  const tracked: Record<string, string> = {};
  if (isObj(o.trackedLists)) {
    for (const [list, entity] of Object.entries(o.trackedLists)) {
      if (list !== "" && list.length <= 200 && typeof entity === "string" && entity !== "")
        tracked[list] = entity;
    }
  }
  return {
    enabled: o.enabled === true && typeof o.consentedAt === "string",
    trackedLists: tracked,
    anchorsFromFolders: o.anchorsFromFolders === "all_granted" ? "all_granted" : "anchored_only",
  };
}

// --- sources ---------------------------------------------------------------------------------

/** Where the signals are read from. Each call may throw: one source failing never stops the rest. */
export interface WorkSources {
  /** Re-reads what the other calls depend on (the connector list). */
  refresh?(): Promise<void>;
  /** Every reminder in the tracked lists, plus open ones elsewhere (to see which name an item). */
  reminders(listIds: readonly string[], signal: AbortSignal): Promise<ReminderRecord[]>;
  events(from: number, to: number, signal: AbortSignal): Promise<CalendarEventRecord[]>;
  /** Files changed since `since` under these anchored paths. */
  files(roots: readonly string[], since: number, signal: AbortSignal): Promise<FileChangeRecord[]>;
  /** Folders inside the granted ones, to offer as anchors when a name matches (W5). */
  folders(signal: AbortSignal): Promise<FolderRecord[]>;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
const list = (out: unknown, ...keys: string[]): Obj[] => {
  const raw = Array.isArray(out)
    ? out
    : isObj(out)
      ? keys.map((k) => out[k]).find(Array.isArray)
      : undefined;
  return (Array.isArray(raw) ? raw : []).filter(isObj);
};

/** Reminders rows as records; `owned` is the connector's own check of whose content a row is. */
export function reminderRecords(rows: Obj[], owned: (row: Obj) => boolean): ReminderRecord[] {
  const out: ReminderRecord[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const id = str(r.id);
    const title = str(r.title);
    if (id === undefined || title === undefined || seen.has(id)) continue;
    seen.add(id);
    const listId = str(r.listId) ?? "";
    const due = str(r.due) ?? str(r.dueDate);
    const completedAt = str(r.completedAt) ?? str(r.completionDate);
    const modifiedAt = str(r.modified) ?? str(r.modifiedAt) ?? str(r.lastModified);
    const link = str(r.url);
    out.push({
      id,
      listId,
      ...(str(r.list) === undefined ? {} : { listTitle: str(r.list) as string }),
      title,
      ...(due === undefined ? {} : { due }),
      completed: r.completed === true,
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(modifiedAt === undefined ? {} : { modifiedAt }),
      ...(link === undefined ? {} : { link }),
      trusted: owned(r),
    });
  }
  return out;
}

/** Calendar rows as records. A recurring event's series is the calendar plus its title. */
export function eventRecords(rows: Obj[], owned: (row: Obj) => boolean): CalendarEventRecord[] {
  const out: CalendarEventRecord[] = [];
  for (const e of rows) {
    const id = str(e.id);
    const title = str(e.title);
    const start = str(e.start);
    if (id === undefined || title === undefined || start === undefined) continue;
    const calendarId = str(e.calendarId) ?? "";
    const recurring = e.recurrence != null || e.recurring === true;
    const series =
      str(e.seriesId) ??
      str(e.recurrenceId) ??
      (recurring ? `${calendarId}:${normalizeName(title)}` : undefined);
    const end = str(e.end);
    const link = str(e.url);
    out.push({
      id,
      calendarId,
      ...(str(e.calendar) === undefined ? {} : { calendarTitle: str(e.calendar) as string }),
      title,
      start,
      ...(end === undefined ? {} : { end }),
      ...(series === undefined ? {} : { seriesId: series }),
      ...(link === undefined ? {} : { link }),
      trusted: owned(e),
    });
  }
  return out;
}

/** `path` is `root` or inside it ("/" or, on Windows, the native separator). */
const within = (path: string, root: string): boolean =>
  path === root ||
  path.startsWith(root.endsWith("/") || root.endsWith(sep) ? root : `${root}${sep}`) ||
  path.startsWith(`${root}/`);

/** Files under `root` changed after `since`: names and times only, bounded, never contents. */
async function sweep(
  root: string,
  since: number,
  signal: AbortSignal,
  out: FileChangeRecord[],
  owner: boolean,
): Promise<void> {
  let budget = MAX_ENTRIES_PER_ROOT;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (signal.aborted || depth > MAX_DEPTH || budget <= 0) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget-- <= 0 || signal.aborted) return;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = await lstat(path);
        if (st.mtimeMs > since) out.push({ path, at: new Date(st.mtimeMs).toISOString(), owner });
      } catch {
        // Gone since the listing.
      }
    }
  };
  await walk(root, 0);
}

async function subfolders(root: string, signal: AbortSignal, out: FolderRecord[]): Promise<void> {
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (signal.aborted || depth > 2 || out.length >= MAX_FOLDERS) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FOLDERS) return;
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      out.push({ path, owner: true });
      await walk(path, depth + 1);
    }
  };
  await walk(root, 1);
}

const isProtected = (path: string): boolean => {
  try {
    assertNotProtected(path, undefined);
    return false;
  } catch {
    return true;
  }
};

/**
 * The real sources: Apple Reminders and Calendar through the connector's tools (the owner's
 * action matrix applies, and the connector's own trust check decides whose content a row is) and
 * the granted folders on disk.
 */
export function appleWorkSources(
  apple: AppleSearchSeams,
  folders: () => readonly { path: string }[],
): WorkSources {
  const roots = () => folders().map((f) => f.path);
  const owned = (app: "reminders" | "calendar") => (row: Obj) =>
    apple.deps.owned?.(app, row) === true;
  return {
    refresh: () => apple.refresh(),
    async reminders(listIds, signal) {
      const call = apple.deps.call("reminders");
      if (call === undefined) return [];
      await apple.deps.refreshTrust?.("reminders", signal);
      const rows: Obj[] = [];
      if (listIds.length > 0) {
        for (const completed of [false, true]) {
          rows.push(
            ...list(
              await call(
                "reminders_list",
                { listIds: [...listIds], completed, limit: 500 },
                signal,
              ),
              "reminders",
            ),
          );
        }
      }
      rows.push(
        ...list(
          await call("reminders_list", { completed: false, limit: 500 }, signal),
          "reminders",
        ),
      );
      return reminderRecords(rows, owned("reminders"));
    },
    async events(from, to, signal) {
      const call = apple.deps.call("calendar");
      if (call === undefined) return [];
      await apple.deps.refreshTrust?.("calendar", signal);
      const out = await call(
        "calendar_list_events",
        { from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit: 2000 },
        signal,
      );
      return eventRecords(list(out, "events"), owned("calendar"));
    },
    async files(anchored, since, signal) {
      const out: FileChangeRecord[] = [];
      for (const root of anchored) {
        // Only inside a granted folder, and never a protected path: that is what "owner" means.
        const owner = roots().some((g) => within(root, g)) && !isProtected(root);
        if (!owner) continue;
        await sweep(root, since, signal, out, true);
      }
      return out;
    },
    async folders(signal) {
      const out: FolderRecord[] = [];
      for (const root of roots()) {
        if (isProtected(root)) continue;
        await subfolders(root, signal, out);
      }
      return out;
    },
  };
}

// --- the part --------------------------------------------------------------------------------

export interface WorkDeps {
  db: PsycheDb;
  clock: Clock;
  people: Pick<People, "graph">;
  /** The Apple seams (the same ones search reads through); absent in tests that inject sources. */
  apple?: AppleSearchSeams;
  /** The folders the owner granted. */
  broker?: { policy: { folders?: readonly { path: string }[] } };
  /** Replaces the real sources (tests). */
  sources?: WorkSources;
  timeZone?: () => string;
  /** Milliseconds between passes (default 15 minutes); 0 turns the timer off (tests). */
  intervalMs?: number;
  logger?: { log(level: "warn", msg: string, fields?: Record<string, unknown>): void };
}

export interface WorkRunResult {
  ran: boolean;
  report?: WorkSignalReport;
  /** Sources that threw (the others still ran). */
  failed: string[];
}

export interface Work {
  /** One pass now. A no-op while work tracking is off or not consented. */
  run(signal?: AbortSignal): Promise<WorkRunResult>;
  settings(): WorkComposeSettings;
  part(): ComposedPart;
}

/** The owner's day as minutes east of UTC. */
function utcOffsetMinutes(timeZone: string, at: number): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(at));
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"));
    return Math.round((asUtc - Math.floor(at / 60_000) * 60_000) / 60_000);
  } catch {
    return 0;
  }
}

export function composeWork(deps: WorkDeps): Work {
  const { db, clock } = deps;
  const graph: GraphStore = deps.people.graph;
  const sources: WorkSources =
    deps.sources ??
    (deps.apple === undefined
      ? {
          reminders: async () => [],
          events: async () => [],
          files: async () => [],
          folders: async () => [],
        }
      : appleWorkSources(deps.apple, () => deps.broker?.policy.folders ?? []));
  const settings = () => workSettings(getSetting(db, MEMORY_WORK_SETTING_KEY)?.value);
  let running = false;

  const run = async (
    signal: AbortSignal = new AbortController().signal,
  ): Promise<WorkRunResult> => {
    const s = settings();
    if (!s.enabled || running) return { ran: false, failed: [] };
    running = true;
    const failed: string[] = [];
    try {
      const now = clock.now();
      await sources.refresh?.().catch(() => failed.push("refresh"));
      const attempt = async <T>(name: string, read: () => Promise<T>): Promise<T | undefined> => {
        try {
          return await read();
        } catch (err) {
          failed.push(name);
          deps.logger?.log("warn", `work signals: reading ${name} failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        }
      };
      const reminders = await attempt("reminders", () =>
        sources.reminders(Object.keys(s.trackedLists), signal),
      );
      const events = await attempt("events", () =>
        sources.events(now - EVENTS_BACK_DAYS * DAY_MS, now + EVENTS_AHEAD_DAYS * DAY_MS, signal),
      );
      // Files: only the folders the owner linked to an item (W5).
      const anchored = graph
        .anchors({ kind: "folder" })
        .filter((a) => a.confirmed)
        .map((a) => a.ref);
      const cursor = graph.cursor(FILES_CURSOR) as { since?: number } | null | undefined;
      const since = cursor?.since ?? now - FILES_FIRST_DAYS * DAY_MS;
      const files =
        anchored.length === 0
          ? []
          : await attempt("files", () => sources.files(anchored, since, signal));
      const folders = await attempt("folders", () => sources.folders(signal));
      const report = runWorkSignals(graph, clock, {
        settings: s,
        ...(reminders === undefined ? {} : { reminders }),
        ...(events === undefined ? {} : { events }),
        ...(files === undefined ? {} : { files }),
        ...(folders === undefined ? {} : { folders }),
        utcOffsetMinutes: utcOffsetMinutes(deps.timeZone?.() ?? "UTC", now),
      });
      // Interactions that name an assignment join its timeline.
      assignProjects(graph, clock);
      if (files !== undefined) graph.setCursor(FILES_CURSOR, { since: now });
      return { ran: true, report, failed };
    } finally {
      running = false;
    }
  };

  return {
    run,
    settings,
    part() {
      let first: NodeJS.Timeout | undefined;
      let timer: NodeJS.Timeout | undefined;
      let abort = new AbortController();
      const safe = () => {
        void run(abort.signal).catch((err) =>
          deps.logger?.log("warn", "work signals pass failed", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      };
      return {
        start() {
          const every = deps.intervalMs ?? PASS_MS;
          if (every <= 0) return;
          abort = new AbortController();
          first = setTimeout(safe, FIRST_PASS_MS);
          first.unref();
          timer = setInterval(safe, every);
          timer.unref();
        },
        stop() {
          abort.abort();
          if (first !== undefined) clearTimeout(first);
          if (timer !== undefined) clearInterval(timer);
        },
      };
    },
  };
}
