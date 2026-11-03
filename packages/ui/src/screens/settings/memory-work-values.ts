import {
  MEMORY_SURFACES_DEFAULTS,
  MEMORY_SURFACES_SETTING_KEY,
  MEMORY_WORK_DEFAULTS,
  MEMORY_WORK_SETTING_KEY,
} from "@psyche/protocol";

/**
 * Reading and writing `memory.work` and `memory.surfaces` (docs/design/memory-everything-2026.md
 * §4, §5.4). Both are stored as one object each, the way `memory.everything` is, because the
 * Gateway's work pass reads the root object (`apps/gateway/src/compose/work.ts`). Reads fill every
 * missing field with the owner's defaults from the protocol, so a partial value shows what the
 * Gateway will use; writes change only the field touched, so a default the owner never changed
 * stays a default.
 */

export const WORK_KEY = MEMORY_WORK_SETTING_KEY;
export const SURFACES_KEY = MEMORY_SURFACES_SETTING_KEY;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The stored object at `key`, or an empty one. */
export function rawOf(values: Readonly<Record<string, unknown>>, key: string): Obj {
  const v = values[key];
  return isObj(v) ? v : {};
}

/** A value at a dotted path inside a stored object, or `undefined`. */
export function at(raw: Obj, path: string): unknown {
  let cur: unknown = raw;
  for (const k of path.split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** A copy of `raw` with `path` set to `value`; nothing else changes. */
export function withPath(raw: Obj, path: string, value: unknown): Obj {
  const keys = path.split(".");
  const out: Obj = { ...raw };
  let cur = out;
  for (const k of keys.slice(0, -1)) {
    const next = cur[k];
    const copy: Obj = isObj(next) ? { ...next } : {};
    cur[k] = copy;
    cur = copy;
  }
  cur[keys.at(-1) as string] = value;
  return out;
}

const flag = (raw: Obj, path: string, fallback: boolean): boolean => {
  const v = at(raw, path);
  return typeof v === "boolean" ? v : fallback;
};

export interface WorkValues {
  enabled: boolean;
  /** Set when the owner has seen the consent card; the Gateway runs only with it. */
  consented: boolean;
  trackedLists: Readonly<Record<string, string>>;
  anchorsFromFolders: "anchored_only" | "all_granted";
  remind: { enabled: boolean; dueSoonHours: number; dayOf: boolean };
}

/** `memory.work` over the §5.4 defaults. */
export function readWork(values: Readonly<Record<string, unknown>>): WorkValues {
  const raw = rawOf(values, WORK_KEY);
  const d = MEMORY_WORK_DEFAULTS;
  const tracked: Record<string, string> = {};
  const list = at(raw, "trackedLists");
  if (isObj(list))
    for (const [id, entity] of Object.entries(list))
      if (typeof entity === "string" && entity !== "") tracked[id] = entity;
  const hours = at(raw, "remind.dueSoonHours");
  return {
    enabled: flag(raw, "enabled", d.enabled),
    consented: typeof raw.consentedAt === "string",
    trackedLists: tracked,
    anchorsFromFolders:
      raw.anchorsFromFolders === "all_granted" ? "all_granted" : d.anchorsFromFolders,
    remind: {
      enabled: flag(raw, "remind.enabled", d.remind.enabled),
      dueSoonHours:
        typeof hours === "number" && Number.isInteger(hours) && hours >= 1 && hours <= 72
          ? hours
          : d.remind.dueSoonHours,
      dayOf: flag(raw, "remind.dayOf", d.remind.dayOf),
    },
  };
}

export const SURFACE_SWITCHES = ["home", "brief", "notification", "channel"] as const;
export type SurfaceSwitch = (typeof SURFACE_SWITCHES)[number];
export const SURFACE_TIERS = ["work", "workMail", "people"] as const;
export type SurfaceTierId = (typeof SURFACE_TIERS)[number];
export const SURFACE_KINDS = ["project", "course", "assignment", "event"] as const;
export type SurfaceKindId = (typeof SURFACE_KINDS)[number];

/** The sources the owner can keep out. Browser pages are never read, so they have no switch. */
export const HIDEABLE_SOURCES = [
  "messages",
  "mail",
  "notes",
  "calendar",
  "reminders",
  "chats",
  "files",
  "transcripts",
  "contacts",
] as const;

export interface SurfaceValues {
  tiers: Record<SurfaceTierId, Record<SurfaceSwitch, boolean>>;
  birthdays: boolean;
  hideSources: readonly string[];
  kinds: Record<SurfaceKindId, boolean>;
}

/** `memory.surfaces` over the §4 defaults. */
export function readSurfaces(values: Readonly<Record<string, unknown>>): SurfaceValues {
  const raw = rawOf(values, SURFACES_KEY);
  const d = MEMORY_SURFACES_DEFAULTS;
  const tiers = {} as SurfaceValues["tiers"];
  for (const tier of SURFACE_TIERS) {
    tiers[tier] = {} as Record<SurfaceSwitch, boolean>;
    for (const sw of SURFACE_SWITCHES)
      tiers[tier][sw] = flag(raw, `tiers.${tier}.${sw}`, d.tiers[tier][sw]);
  }
  const kinds = {} as SurfaceValues["kinds"];
  for (const k of SURFACE_KINDS) kinds[k] = flag(raw, `kinds.${k}`, d.kinds[k]);
  const hidden = at(raw, "hideSources");
  return {
    tiers,
    birthdays: flag(raw, "birthdays", d.birthdays),
    hideSources: Array.isArray(hidden)
      ? hidden.filter((s): s is string => typeof s === "string")
      : [],
    kinds,
  };
}
