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
  "platform.helper.choose.title": "Sono connessi due Psyche Helper",
  "platform.helper.choose.text":
    "Psyche non tira a indovinare quale giri su questo computer, quindi Mail, Note, Calendario e Promemoria sono in pausa. Scegli quello da usare.",
  "platform.helper.choose.use": "Usa {name}",
  "platform.helper.choose.failed": "Impossibile scegliere l'assistente: {reason}",
};
