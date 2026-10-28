/**
 * What Psyche can do, by what is connected: the catalogue behind onboarding's First wins step and
 * the "What can you do?" screen. Pure data; strings live in `i18n/messages/capabilities.ts`.
 */

/** A connector type or family a capability needs; any one of `anyOf` is enough. */
export interface CapabilityNeed {
  anyOf: readonly string[];
}

const MAIL: CapabilityNeed = { anyOf: ["apple:mail", "google", "microsoft", "imap"] };
const CALENDAR: CapabilityNeed = { anyOf: ["apple:calendar", "google", "microsoft"] };
const REMINDERS: CapabilityNeed = { anyOf: ["apple:reminders"] };
const NOTES: CapabilityNeed = { anyOf: ["apple:notes", "obsidian"] };

export const CAPABILITY_IDS = [
  "brief",
  "meetings",
  "inbox",
  "reminders",
  "notes",
  "research",
  "files",
  "automate",
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export interface Capability {
  id: CapabilityId;
  /** Absent: works with nothing connected. */
  needs?: CapabilityNeed;
  /** Example prompts (i18n keys `capabilities.<id>.prompt<N>`). */
  prompts: readonly number[];
  /** A starter automation the owner can create from the card (i18n `capabilities.<id>.auto`). */
  automation?: { cron: string };
}

export const CAPABILITIES: readonly Capability[] = [
  { id: "brief", needs: CALENDAR, prompts: [1, 2], automation: { cron: "30 7 * * 1-5" } },
  { id: "meetings", needs: CALENDAR, prompts: [1, 2] },
  { id: "inbox", needs: MAIL, prompts: [1, 2], automation: { cron: "0 8 * * 1-5" } },
  { id: "reminders", needs: REMINDERS, prompts: [1, 2] },
  { id: "notes", needs: NOTES, prompts: [1, 2] },
  { id: "research", prompts: [1, 2] },
  { id: "files", prompts: [1, 2] },
  { id: "automate", prompts: [1, 2] },
];

/** True when the capability needs nothing, or one of the needed connectors is connected. */
export function isAvailable(capability: Capability, connected: ReadonlySet<string>): boolean {
  return capability.needs === undefined || capability.needs.anyOf.some((t) => connected.has(t));
}

/** The three live starter tasks (onboarding "First wins"). */
export const WIN_IDS = ["brief", "meetings", "inbox"] as const;
export type WinId = (typeof WIN_IDS)[number];

export const WIN_NEEDS: Record<WinId, CapabilityNeed> = {
  brief: CALENDAR,
  meetings: CALENDAR,
  inbox: MAIL,
};

/** Which wins can run with what is connected; the rest degrade to a "connect X" hint. */
export function runnableWins(connected: ReadonlySet<string>): Record<WinId, boolean> {
  const ok = (id: WinId) => WIN_NEEDS[id].anyOf.some((t) => connected.has(t));
  return { brief: ok("brief"), meetings: ok("meetings"), inbox: ok("inbox") };
}
