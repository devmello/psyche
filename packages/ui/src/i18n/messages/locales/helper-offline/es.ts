import type { Catalogue } from "../../index.ts";

/** The helper-offline banner in the desktop app (es); merged into `../es.ts`. */
export const helperOffline: Partial<Catalogue> = {
  "platform.helper.offline.title": "El Helper de Psyche no está conectado",
  "platform.helper.offline.text":
    "El correo, las notas, el calendario, los recordatorios y el trabajo que depende de ellos esperan a que se vuelva a conectar.",
  "platform.helper.offline.reconnect": "Volver a conectar",
  "platform.helper.contactsPermission":
    "Los contactos necesitan permiso para el Helper de Psyche en Ajustes del Sistema.",
  "platform.helper.offline.dismiss": "Descartar",
};
