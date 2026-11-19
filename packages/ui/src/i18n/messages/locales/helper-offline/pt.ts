import type { Catalogue } from "../../index.ts";

/** The helper-offline banner in the desktop app (pt); merged into `../pt.ts`. */
export const helperOffline: Partial<Catalogue> = {
  "platform.helper.offline.title": "O Psyche Helper não está conectado",
  "platform.helper.offline.text":
    "E-mail, Notas, Calendário, Lembretes e o trabalho que depende deles esperam até ele reconectar.",
  "platform.helper.offline.reconnect": "Reconectar",
  "platform.helper.contactsPermission":
    "Os Contatos precisam de permissão para o Psyche Helper nos Ajustes do Sistema.",
  "platform.helper.offline.dismiss": "Dispensar",
  "platform.helper.choose.title": "Dois Psyche Helper estão conectados",
  "platform.helper.choose.text":
    "O Psyche não adivinha qual deles roda neste computador, então Mail, Notas, Calendário e Lembretes estão em pausa. Escolha o que deve ser usado.",
  "platform.helper.choose.use": "Usar {name}",
  "platform.helper.choose.failed": "Não foi possível escolher o assistente: {reason}",
};
