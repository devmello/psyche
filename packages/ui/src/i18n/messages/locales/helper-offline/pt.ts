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
  "platform.helper.choose.title": "Mais de um Psyche Helper está conectado",
  "platform.helper.choose.text":
    "O Psyche não vai escolher por você, então Mail, Notas, Calendário e Lembretes estão em pausa. Escolha qual usar enquanto todos estiverem conectados.",
  "platform.helper.choose.use": "Usar o assistente pareado em {when} (…{id})",
  "platform.helper.choose.useNoTime": "Usar o assistente (…{id})",
  "platform.helper.choose.name": "Chama a si mesmo de: {name}",
  "platform.helper.choose.failed": "Não foi possível escolher o assistente: {reason}",
};
