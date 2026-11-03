import {
  rawOf,
  readSurfaces,
  readWork,
  SURFACES_KEY,
  WORK_KEY,
  withPath,
} from "../settings/memory-work-values.ts";
import type { MemoryChoices } from "./types.ts";

/**
 * The Memory step's choices as Gateway settings (docs/design/onboarding-2026.md §4). They reuse
 * Settings → Memory → Work and Where memory shows: the same two objects, the same defaults, and
 * a write that changes only the field the owner touched, so a Reminders list or a switch set in
 * Settings survives a re-run.
 */

export const MEMORY_CHOICE_DEFAULTS: MemoryChoices = {
  work: false,
  workConsentedAt: null,
  remind: false,
  people: false,
};

/** What the step starts with: the stored settings over the owner's defaults. */
export function readMemoryChoices(values: Readonly<Record<string, unknown>>): MemoryChoices {
  const consented = rawOf(values, WORK_KEY).consentedAt;
  return {
    work: readWork(values).enabled,
    workConsentedAt: typeof consented === "string" ? consented : null,
    remind: readWork(values).remind.enabled,
    people: readSurfaces(values).tiers.people.brief,
  };
}

/**
 * The settings to write for `choices`, given what is stored now: only objects that change. Work
 * can only be on with `consentedAt` set (the Gateway's work pass runs only then).
 */
export function memorySettings(
  values: Readonly<Record<string, unknown>>,
  choices: MemoryChoices,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const before = readMemoryChoices(values);

  if (
    choices.work !== before.work ||
    choices.workConsentedAt !== before.workConsentedAt ||
    choices.remind !== before.remind
  ) {
    let work = withPath(rawOf(values, WORK_KEY), "enabled", choices.work);
    if (choices.work && choices.workConsentedAt !== null)
      work = withPath(work, "consentedAt", choices.workConsentedAt);
    if (choices.remind !== before.remind) work = withPath(work, "remind.enabled", choices.remind);
    out[WORK_KEY] = work;
  }
  if (choices.people !== before.people)
    out[SURFACES_KEY] = withPath(rawOf(values, SURFACES_KEY), "tiers.people.brief", choices.people);
  return out;
}

/** The settings keys onboarding reads to pre-fill and to compare against. */
export const MEMORY_CHOICE_KEYS = [WORK_KEY, SURFACES_KEY] as const;
