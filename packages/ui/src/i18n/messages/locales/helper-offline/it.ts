import type { Catalogue } from "../../index.ts";

/** The helper-offline banner in the desktop app (it); merged into `../it.ts`. */
export const helperOffline: Partial<Catalogue> = {
  "platform.helper.offline.title": "Psyche Helper non è connesso",
  "platform.helper.offline.text":
    "Posta, Note, Calendario, Promemoria e il lavoro che ne dipende restano in attesa della riconnessione.",
  "platform.helper.offline.reconnect": "Riconnetti",
  "platform.helper.contactsPermission":
    "I Contatti richiedono il permesso per Psyche Helper nelle Impostazioni di Sistema.",
  "platform.helper.offline.dismiss": "Chiudi",
  "platform.helper.choose.title": "È connesso più di un Psyche Helper",
  "platform.helper.choose.text":
    "Psyche non sceglierà per te, quindi Mail, Note, Calendario e Promemoria sono in pausa. Scegli quale usare finché sono tutti connessi.",
  "platform.helper.choose.use": "Usa l'assistente associato il {when} (…{id})",
  "platform.helper.choose.useNoTime": "Usa l'assistente (…{id})",
  "platform.helper.choose.name": "Si definisce: {name}",
  "platform.helper.choose.failed": "Impossibile scegliere l'assistente: {reason}",
};
