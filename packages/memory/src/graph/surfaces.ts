import {
  type GraphCitationSource,
  type GraphEdge,
  type GraphEntityKind,
  type GraphFact,
  type GraphFactAttribute,
  MEMORY_SURFACES_DEFAULTS,
  type MemorySurface,
  type MemorySurfaceSwitches,
  type MemorySurfacesSettings,
} from "@psyche/protocol";

/**
 * Surfaces: everywhere memory can show up outside the Memory page (Home, the brief, OS
 * notifications, a brief delivered to a channel). docs/design/memory-everything-2026.md §4.
 *
 * Every surface reads memory through `surfaceFilter`, so there is one place that knows the tier
 * defaults and the owner's switches. The brief, Home, notifications and channel delivery all call
 * it; a test runs each surface with the people tier off and asserts that no person fact, gist or
 * relation gets through.
 */

export const SURFACES: readonly MemorySurface[] = ["home", "brief", "notification", "channel"];

/**
 * - `work`: projects, courses, assignments, their status and due dates, and the owner's calendars.
 * - `workMail`: subjects and senders of mail tied to tracked work (W2).
 * - `people`: facts about other people, relations, conversation gists, life events, Keep in touch.
 * - `birthday`: birthdays and anniversaries, dates only (W1: their own switch, on by default).
 * - `sensitive`: any fact with a sensitivity class. Never outside the Memory page.
 */
export type SurfaceTier = "work" | "workMail" | "people" | "birthday" | "sensitive";

/** The per-kind switch a work item answers to. A course is a project with a type. */
export type SurfaceKind = "project" | "course" | "assignment" | "event";

/** What `surfaceFilter` needs to know about a piece of memory. Anything richer rides along. */
export interface SurfaceItem {
  tier: SurfaceTier;
  /** Work tier: the kind switch (§4 "per kind"). */
  kind?: SurfaceKind;
  entityId?: string;
  /** The owner's Keep private on the item (the `private` column): Memory page only. */
  private?: boolean;
  /** Where it was learned, for the per-source veto ("Don't show anything learned from Messages"). */
  sources?: readonly GraphCitationSource[];
  /** Carries a sensitivity class (health, finance and so on). */
  sensitive?: boolean;
  /** Still a suggestion in Review. A pending item never shows anywhere. */
  pending?: boolean;
}

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const obj = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function switches(value: unknown, fallback: MemorySurfaceSwitches): MemorySurfaceSwitches {
  const v = obj(value);
  return {
    home: bool(v.home, fallback.home),
    brief: bool(v.brief, fallback.brief),
    notification: bool(v.notification, fallback.notification),
    channel: bool(v.channel, fallback.channel),
  };
}

const SOURCES: readonly string[] = [
  "mail",
  "messages",
  "notes",
  "calendar",
  "reminders",
  "chats",
  "files",
  "browser",
  "transcripts",
  "contacts",
];

/**
 * The owner's `memory.surfaces` settings with every missing or malformed field read as the
 * decision in §9: work and work mail on for Home and the brief, people off everywhere, birthdays
 * on. Never throws, so a bad stored value can only fall back to the defaults.
 */
export function resolveSurfaceSettings(raw: unknown): MemorySurfacesSettings {
  const v = obj(raw);
  const tiers = obj(v.tiers);
  const kinds = obj(v.kinds);
  const d = MEMORY_SURFACES_DEFAULTS;
  return {
    tiers: {
      work: switches(tiers.work, d.tiers.work),
      workMail: switches(tiers.workMail, d.tiers.workMail),
      people: switches(tiers.people, d.tiers.people),
    },
    birthdays: bool(v.birthdays, d.birthdays),
    hideSources: Array.isArray(v.hideSources)
      ? (v.hideSources.filter(
          (s): s is GraphCitationSource => typeof s === "string" && SOURCES.includes(s),
        ) as GraphCitationSource[])
      : [],
    kinds: {
      project: bool(kinds.project, d.kinds.project),
      course: bool(kinds.course, d.kinds.course),
      assignment: bool(kinds.assignment, d.kinds.assignment),
      event: bool(kinds.event, d.kinds.event),
    },
  };
}

/** Whether one item may appear on a surface. The rules, in the order they bite. */
export function surfaceAllows(
  item: SurfaceItem,
  surface: MemorySurface,
  settings: MemorySurfacesSettings,
): boolean {
  // Never, on any surface and with any switch.
  if (item.tier === "sensitive" || item.sensitive === true) return false;
  if (item.pending === true) return false;
  // Keep private: that item shows on its Memory page only.
  if (item.private === true) return false;
  // The per-source veto composes with everything else.
  if (item.sources?.some((s) => settings.hideSources.includes(s)) === true) return false;
  switch (item.tier) {
    case "work":
      if (item.kind !== undefined && !settings.kinds[item.kind]) return false;
      return settings.tiers.work[surface];
    case "workMail":
      return settings.tiers.workMail[surface];
    case "people":
      return settings.tiers.people[surface];
    case "birthday":
      // Their own switch for Home and the brief; never in a notification or a channel unless
      // the owner opened the whole people tier there.
      return surface === "home" || surface === "brief"
        ? settings.birthdays || settings.tiers.people[surface]
        : settings.tiers.people[surface];
  }
}

/**
 * The one function every surface reads memory through. Returns the items that may appear on
 * `surface`, in their original order.
 */
export function surfaceFilter<T extends SurfaceItem>(
  items: readonly T[],
  surface: MemorySurface,
  settings: MemorySurfacesSettings = resolveSurfaceSettings(undefined),
): T[] {
  return items.filter((item) => surfaceAllows(item, surface, settings));
}

// --- classifying what the graph holds ------------------------------------------------------------

/** The facts that belong to work (§2.3). Everything else on an entity is about a person or a place. */
const WORK_FACT_ATTRIBUTES: ReadonlySet<GraphFactAttribute> = new Set([
  "status",
  "deadline",
  "next_step",
  "stopped_at",
  "progress",
  "blocked_on",
  "course_code",
  "term",
  "meets",
]);

/** A work item is a project, course, assignment or event; a fact about it is work tier. */
export function factItem(
  fact: Pick<GraphFact, "attribute" | "sensitivity" | "review"> & { entityId?: string },
  entityKind: GraphEntityKind,
): SurfaceItem {
  const sensitive = (fact.sensitivity ?? "none") !== "none";
  const pending = fact.review === "pending";
  const base = {
    ...(fact.entityId === undefined ? {} : { entityId: fact.entityId }),
    ...(sensitive ? { sensitive } : {}),
    ...(pending ? { pending } : {}),
  };
  if (fact.attribute === "birthday" || fact.attribute === "anniversary")
    return { tier: "birthday", ...base };
  const workKind =
    entityKind === "project" || entityKind === "assignment" || entityKind === "event";
  if (workKind && WORK_FACT_ATTRIBUTES.has(fact.attribute)) return { tier: "work", ...base };
  return { tier: "people", ...base };
}

/** A relation names someone (an assigner, a teacher, family): people, unless it only nests work. */
export function relationItem(edge: Pick<GraphEdge, "rel">): SurfaceItem {
  return { tier: edge.rel === "part_of" ? "work" : "people" };
}

/** What a conversation was about: always the people tier (§4). */
export function gistItem(entityId?: string): SurfaceItem {
  return { tier: "people", ...(entityId === undefined ? {} : { entityId }) };
}
