import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (pt); merged into `../pt.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "Manter este computador acordado",
  "settings.daily.keepAwake.hint":
    "Enquanto uma tarefa agendada está em andamento, este computador não entra em suspensão até ela terminar. A tela ainda pode apagar.",
  "settings.key.scheduled.keepAwake":
    "Manter este computador acordado enquanto as tarefas agendadas rodam",
  "scheduled.history.retryingAt": "Nova tentativa às {time}",
  "scheduled.history.retry": "Tentativa {n} de 3",
  "scheduled.history.failedAfterRetries": "Falhou após {n} novas tentativas",
};
