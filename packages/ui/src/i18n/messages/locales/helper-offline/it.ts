import type { Catalogue } from "../../index.ts";

/** The helper-offline banner in the desktop app (it); merged into `../it.ts`. */
export const helperOffline: Partial<Catalogue> = {
  "platform.helper.offline.title": "Psyche Helper non è connesso",
  "platform.helper.offline.text":
    "Posta, Note, Calendario, Promemoria e il lavoro che ne dipende restano in attesa della riconnessione.",
  "platform.helper.offline.reconnect": "Riconnetti",
  "platform.helper.offline.dismiss": "Chiudi",
};
