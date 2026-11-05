import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, StringEnum } from "../common.ts";
import { GraphCitationSource } from "./graph.ts";

/**
 * Settings for memory that tracks work (docs/design/memory-everything-2026.md §4, §5.4), stored
 * under `memory.work.*` and `memory.surfaces.*`. The root `memory` is not in the cosmetic
 * allowlist, so every write needs `operator.admin` and the extractor principal can never reach
 * them (W6). Every field has a default below, so a missing key reads as the owner's decision.
 */

const bool = (def: boolean, description?: string) => Type.Boolean({ default: def, description });

const HHMM = "([01]\\d|2[0-3]):[0-5]\\d";

/** Where anchored folders are matched (decision W5). */
export const MemoryWorkFolders = StringEnum(["anchored_only", "all_granted"], {
  $id: "MemoryWorkFolders",
  description:
    "anchored_only: only folders linked to a project or course; all_granted: every granted folder, matched by name",
});
export type MemoryWorkFolders = Static<typeof MemoryWorkFolders>;

export const MemoryWorkSettings = Type.Object(
  {
    enabled: bool(false, "Off until the owner consents; turning it on shows a one-screen card"),
    consentedAt: Type.Optional(IsoDateTime),
    trackedLists: Type.Record(Type.String({ minLength: 1, maxLength: 200 }), Id, {
      default: {},
      description: "Reminders list id to the project or course it feeds",
    }),
    anchorsFromFolders: MemoryWorkFolders,
    remind: Type.Object(
      {
        enabled: bool(false, "Due-soon notification, off by default (W4)"),
        dueSoonHours: Type.Integer({ minimum: 1, maximum: 72, default: 24 }),
        at: Type.String({
          pattern: `^(wrapup|${HHMM})$`,
          default: "wrapup",
          description: '"wrapup" (18:00 by default) or a local time HH:MM',
        }),
        dayOf: bool(false, "A separate morning notification for things due today, off (W4)"),
      },
      { $id: "MemoryWorkRemind" },
    ),
    askWhereStopped: bool(false, "Ask once at wrap-up where the owner stopped"),
  },
  { $id: "MemoryWorkSettings" },
);
export type MemoryWorkSettings = Static<typeof MemoryWorkSettings>;

export const MEMORY_WORK_DEFAULTS = {
  enabled: false,
  trackedLists: {},
  anchorsFromFolders: "anchored_only",
  remind: { enabled: false, dueSoonHours: 24, at: "wrapup", dayOf: false },
  askWhereStopped: false,
} as const satisfies MemoryWorkSettings;

export const MEMORY_WORK_SETTING_KEY = "memory.work" as const;

/** A Reminders list work tracking can follow (`trackedLists` keys), from any Reminders backend. */
export const WorkReminderList = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 500 }),
    name: Type.String({ maxLength: 500 }),
    shared: Type.Boolean({
      description: "Someone else can add to it (shared, read-only, flagged email): untrusted",
    }),
    source: Type.Optional(
      Type.String({ maxLength: 100, description: "Where it lives, e.g. Microsoft To Do" }),
    ),
  },
  { $id: "WorkReminderList" },
);
export type WorkReminderList = Static<typeof WorkReminderList>;

/** The places memory can show up outside the Memory page (§4). */
export const MemorySurface = StringEnum(["home", "brief", "notification", "channel"], {
  $id: "MemorySurface",
});
export type MemorySurface = Static<typeof MemorySurface>;

/** One switch per surface for a tier. */
export const MemorySurfaceSwitches = Type.Object(
  {
    home: Type.Boolean(),
    brief: Type.Boolean(),
    notification: Type.Boolean({
      description:
        'Work tier: titles only for owner-provenance items, otherwise a count ("1 assignment due tomorrow")',
    }),
    channel: Type.Boolean({ description: "The brief delivered to Telegram and other channels" }),
  },
  { $id: "MemorySurfaceSwitches" },
);
export type MemorySurfaceSwitches = Static<typeof MemorySurfaceSwitches>;

/**
 * `memory.surfaces`: which tier shows where. The sensitive tier has no switch: it never shows
 * outside the Memory page.
 */
export const MemorySurfacesSettings = Type.Object(
  {
    tiers: Type.Object(
      {
        work: MemorySurfaceSwitches,
        workMail: MemorySurfaceSwitches,
        people: MemorySurfaceSwitches,
      },
      {
        $id: "MemorySurfaceTiers",
        description:
          "work: projects, courses, assignments and the owner's own calendars; workMail: subjects of mail tied to tracked work (W2); people: facts, gists and relations about other people",
      },
    ),
    birthdays: bool(
      true,
      "Dates of birthdays and anniversaries in the brief's Coming up and on Home (W1); never in notifications",
    ),
    hideSources: Type.Array(GraphCitationSource, {
      maxItems: 16,
      default: [],
      description: "Never show anything learned from these sources outside Memory",
    }),
    kinds: Type.Object(
      {
        project: bool(true),
        course: bool(true),
        assignment: bool(true),
        event: bool(true),
      },
      {
        $id: "MemorySurfaceKinds",
        description: "Turn a whole kind off on every surface",
      },
    ),
  },
  { $id: "MemorySurfacesSettings" },
);
export type MemorySurfacesSettings = Static<typeof MemorySurfacesSettings>;

export const MEMORY_SURFACES_DEFAULTS = {
  tiers: {
    work: { home: true, brief: true, notification: true, channel: true },
    workMail: { home: true, brief: true, notification: false, channel: false },
    people: { home: false, brief: false, notification: false, channel: false },
  },
  birthdays: true,
  hideSources: [],
  kinds: { project: true, course: true, assignment: true, event: true },
} as const satisfies MemorySurfacesSettings;

export const MEMORY_SURFACES_SETTING_KEY = "memory.surfaces" as const;
