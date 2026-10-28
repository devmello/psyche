import type { MailChoices } from "./types.ts";

/** What the screen starts with (§7.5). */
export const MAIL_DEFAULTS: MailChoices = {
  digest: true,
  prep: true,
  followups: true,
  voice: false,
  notes: true,
};

/** The Gateway settings a set of choices writes (one switch each; the digest at 7:30). */
export function mailSettings(choices: MailChoices): Record<string, boolean | string> {
  return {
    "mail.digest.enabled": choices.digest,
    ...(choices.digest ? { "mail.digest.time": "07:30" } : {}),
    "meetings.prep.enabled": choices.prep,
    "mail.followups.enabled": choices.followups,
    "mail.voice.enabled": choices.voice,
    "meetings.notes.enabled": choices.notes,
  };
}
