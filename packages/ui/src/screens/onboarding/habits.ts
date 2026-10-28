/**
 * Onboarding's "Turn on habits" step: the switches and the settings keys they write.
 *
 * TODO(daily-habit): the parallel `daily-habit` session owns the brief / wrap-up / follow-up
 * settings. Until its keys are on main this maps to the existing proactive toggles; the evening
 * wrap-up has no key yet, so `HABIT_KEYS.wrapup` is a named placeholder written best effort.
 * Swap the values below for its keys and nothing else here changes.
 */
export interface HabitChoices {
  brief: boolean;
  wrapup: boolean;
  followups: boolean;
}

export const HABIT_DEFAULTS: HabitChoices = { brief: true, wrapup: false, followups: true };

export const HABIT_KEYS: Record<keyof HabitChoices, string> = {
  brief: "mail.digest.enabled",
  wrapup: "habits.wrapup.enabled", // TODO(daily-habit): replace with the landed key
  followups: "mail.followups.enabled",
};

export function habitSettings(choices: HabitChoices): Record<string, boolean | string> {
  return {
    [HABIT_KEYS.brief]: choices.brief,
    ...(choices.brief ? { "mail.digest.time": "07:30" } : {}),
    [HABIT_KEYS.wrapup]: choices.wrapup,
    [HABIT_KEYS.followups]: choices.followups,
  };
}
