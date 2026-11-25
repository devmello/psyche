import type { Catalogue } from "../../index.ts";

/** Failure messages for user actions (it); merged into `../it.ts`. */
export const actionErrors: Partial<Catalogue> = {
  "actionError.exportPerson": "Impossibile esportare i dati di questa persona ({reason}).",
  "actionError.revokeGrant": "Impossibile revocare questa approvazione ({reason}). Resta attiva.",
  "actionError.reindex": "Impossibile ricostruire l'indice di ricerca ({reason}).",
  "actionError.rerun": "Impossibile rieseguire questa automazione ({reason}).",
  "actionError.stopResearch": "Impossibile fermare la ricerca ({reason}). È ancora in corso.",
  "actionError.unmute": "Impossibile riattivare i promemoria ({reason}).",
  "actionError.language": "Impossibile cambiare la lingua ({reason}).",
  "actionError.transcriptMode":
    "Impossibile cambiare il livello di dettaglio della trascrizione ({reason}).",
  "actionError.screenAskDestination":
    "Impossibile cambiare la destinazione delle domande sullo schermo ({reason}).",
  "actionError.stopVirtualScreen":
    "Impossibile fermare lo schermo virtuale ({reason}). Potrebbe essere ancora in esecuzione.",
  "actionError.takeOver": "Impossibile prendere il controllo dello schermo virtuale ({reason}).",
};
