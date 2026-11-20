import type { Catalogue } from "../../index.ts";

/** Follow-ups on quiet email threads (es); merged into `../es.ts`. */
export const mailFollowups: Partial<Catalogue> = {
  "home.quietThreads": "Hilos de correo en silencio",
  "home.quietThreads.hint": "Correos que esperan una respuesta, tuya o de la otra persona",
  "mailFollowups.someone": "Alguien",
  "mailFollowups.line.noReply":
    "{who} no ha respondido en {days, plural, one {# día} other {# días}}",
  "mailFollowups.line.question":
    "{who} te preguntó algo hace {days, plural, one {# día} other {# días}}",
  "mailFollowups.draft": "Redactar un seguimiento",
  "mailFollowups.snooze": "Posponer",
  "mailFollowups.dismiss": "Descartar",
  "mailFollowups.failed": "No se pudo: {reason}",
  "mailFollowups.prefill": "Redacta un seguimiento para este hilo.",
  "mailFollowups.thread.title": "Seguimiento de correo",
  "chat.composer.placeholderMail": "Pregunta sobre este hilo",
  "daily.section.quiet_threads": "Hilos de correo en silencio",
};
