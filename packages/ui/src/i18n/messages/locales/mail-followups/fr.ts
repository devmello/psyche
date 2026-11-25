import type { Catalogue } from "../../index.ts";

/** Follow-ups on quiet email threads (fr); merged into `../fr.ts`. */
export const mailFollowups: Partial<Catalogue> = {
  "home.quietThreads": "Fils de mails restés sans suite",
  "home.quietThreads.hint": "Des mails qui attendent une réponse, de ta part ou de la leur",
  "mailFollowups.someone": "Quelqu’un",
  "mailFollowups.line.noReply":
    "{who} n’a pas répondu depuis {days, plural, one {# jour} other {# jours}}",
  "mailFollowups.line.question":
    "{who} t’a posé une question il y a {days, plural, one {# jour} other {# jours}}",
  "mailFollowups.draft": "Rédiger une relance",
  "mailFollowups.snooze": "Reporter",
  "mailFollowups.dismiss": "Ignorer",
  "mailFollowups.failed": "Impossible : {reason}",
  "mailFollowups.prefill": "Rédige une relance pour ce fil.",
  "mailFollowups.thread.title": "Relance par mail",
  "chat.composer.placeholderMail": "Pose une question sur ce fil",
  "daily.section.quiet_threads": "Fils de mails restés sans suite",
  "daily.section.promises": "Promesses",
  "screens.inbox.kind.promise_due": "Promesse à tenir",
};
