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
  "platform.helper.choose.title": "Hay más de un Psyche Helper conectado",
  "platform.helper.choose.text":
    "Psyche no elegirá por ti, así que Mail, Notas, Calendario y Recordatorios están en pausa. Elige cuál usar mientras todos estén conectados.",
  "platform.helper.choose.use": "Usar el asistente emparejado el {when} (…{id})",
  "platform.helper.choose.useNoTime": "Usar el asistente (…{id})",
  "platform.helper.choose.name": "Se llama a sí mismo: {name}",
  "platform.helper.choose.failed": "No se pudo elegir el asistente: {reason}",
};
