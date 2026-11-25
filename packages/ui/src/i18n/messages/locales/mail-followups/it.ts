import type { Catalogue } from "../../index.ts";

/** Follow-ups on quiet email threads (it); merged into `../it.ts`. */
export const mailFollowups: Partial<Catalogue> = {
  "home.quietThreads": "Conversazioni email ferme",
  "home.quietThreads.hint": "Email in attesa di una risposta, tua o dell’altra persona",
  "mailFollowups.someone": "Qualcuno",
  "mailFollowups.line.noReply":
    "{who} non risponde da {days, plural, one {# giorno} other {# giorni}}",
  "mailFollowups.line.question":
    "{who} ti ha chiesto qualcosa {days, plural, one {# giorno} other {# giorni}} fa",
  "mailFollowups.draft": "Prepara un sollecito",
  "mailFollowups.snooze": "Rimanda",
  "mailFollowups.dismiss": "Ignora",
  "mailFollowups.failed": "Non è stato possibile: {reason}",
  "mailFollowups.prefill": "Prepara un sollecito per questa conversazione.",
  "mailFollowups.thread.title": "Sollecito email",
  "chat.composer.placeholderMail": "Chiedi di questa conversazione",
  "daily.section.quiet_threads": "Conversazioni email ferme",
<<<<<<< HEAD
  "daily.section.promises": "Promesse",
  "screens.inbox.kind.promise_due": "Promessa in scadenza",
=======
>>>>>>> origin/main
  "daily.section.night_shift": "Turno di notte",
};
