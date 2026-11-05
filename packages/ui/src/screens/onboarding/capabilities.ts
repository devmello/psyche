/**
 * What Psyche can do, by what is connected: the catalogue behind the "What can you do?" screen. Pure data; strings live in `i18n/messages/capabilities.ts`.
 */

/** A connector type or family a capability needs; any one of `anyOf` is enough. */
export interface CapabilityNeed {
  anyOf: readonly string[];
}

const MAIL: CapabilityNeed = { anyOf: ["apple:mail", "google", "microsoft", "imap"] };
const CALENDAR: CapabilityNeed = { anyOf: ["apple:calendar", "google", "microsoft"] };
/**
 * `apple:reminders` is Reminders on a Mac and Outlook Tasks through the Windows helper (the same
 * type). `microsoft:todo` is Microsoft To Do: a Microsoft 365 connection that holds the To Do
 * scope (`connectedTypesOf`).
 */
const REMINDERS: CapabilityNeed = { anyOf: ["apple:reminders", "microsoft:todo"] };
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
