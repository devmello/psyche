/**
 * Onboarding's "Turn on habits" step: the switches and the settings keys they write. The keys
 * are the daily-habit session's (PR #989, `daily.*`); both habits default off until set here.
 */
export interface HabitChoices {
  brief: boolean;
  wrapup: boolean;
  followups: boolean;
}

export const HABIT_DEFAULTS: HabitChoices = { brief: true, wrapup: false, followups: true };

export const HABIT_KEYS: Record<keyof HabitChoices, string> = {
  brief: "daily.brief.enabled",
  wrapup: "daily.wrapup.enabled",
  followups: "daily.followups.enabled",
};

export function habitSettings(choices: HabitChoices): Record<string, boolean> {
  return {
    [HABIT_KEYS.brief]: choices.brief,
    [HABIT_KEYS.wrapup]: choices.wrapup,
    [HABIT_KEYS.followups]: choices.followups,
  };
}
