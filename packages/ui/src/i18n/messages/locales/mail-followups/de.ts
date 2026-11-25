import type { Catalogue } from "../../index.ts";

/** Follow-ups on quiet email threads (de); merged into `../de.ts`. */
export const mailFollowups: Partial<Catalogue> = {
  "home.quietThreads": "Ruhige E-Mail-Verläufe",
  "home.quietThreads.hint": "Mails, die auf eine Antwort warten, von dir oder von anderen",
  "mailFollowups.someone": "Jemand",
  "mailFollowups.line.noReply":
    "{who} hat seit {days, plural, one {# Tag} other {# Tagen}} nicht geantwortet",
  "mailFollowups.line.question":
    "{who} hat dich vor {days, plural, one {# Tag} other {# Tagen}} etwas gefragt",
  "mailFollowups.draft": "Nachfassen entwerfen",
  "mailFollowups.snooze": "Zurückstellen",
  "mailFollowups.dismiss": "Verwerfen",
  "mailFollowups.failed": "Das hat nicht geklappt: {reason}",
  "mailFollowups.prefill": "Entwirf eine Nachfrage zu diesem Verlauf.",
  "mailFollowups.thread.title": "E-Mail-Nachfrage",
  "chat.composer.placeholderMail": "Frag zu diesem Verlauf",
  "daily.section.quiet_threads": "Ruhige E-Mail-Verläufe",
  "daily.section.night_shift": "Nachtschicht",
};
