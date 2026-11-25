import type { Catalogue } from "../../index.ts";

/** Follow-ups on quiet email threads (pt); merged into `../pt.ts`. */
export const mailFollowups: Partial<Catalogue> = {
  "home.quietThreads": "Conversas de e-mail paradas",
  "home.quietThreads.hint": "E-mails esperando uma resposta, sua ou da outra pessoa",
  "mailFollowups.someone": "Alguém",
  "mailFollowups.line.noReply":
    "{who} não responde há {days, plural, one {# dia} many {# de dias} other {# dias}}",
  "mailFollowups.line.question":
    "{who} te perguntou algo há {days, plural, one {# dia} many {# de dias} other {# dias}}",
  "mailFollowups.draft": "Rascunhar um acompanhamento",
  "mailFollowups.snooze": "Adiar",
  "mailFollowups.dismiss": "Dispensar",
  "mailFollowups.failed": "Não foi possível: {reason}",
  "mailFollowups.prefill": "Escreva um rascunho de acompanhamento para esta conversa.",
  "mailFollowups.thread.title": "Acompanhamento de e-mail",
  "chat.composer.placeholderMail": "Pergunte sobre esta conversa",
  "daily.section.quiet_threads": "Conversas de e-mail paradas",
  "daily.section.night_shift": "Turno da noite",
};
