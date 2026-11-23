import type { Catalogue } from "../../index.ts";

/** App update strings (it); merged into `../it.ts`. */
export const update: Partial<Catalogue> = {
  "shell.update.ready": "Psyche {version} è pronto",
  "shell.update.readyRequired": "Psyche {version} è pronto. Questo aggiornamento è obbligatorio.",
  "shell.update.restart": "Riavvia per aggiornare",
  "shell.update.dismiss": "Nascondi l’avviso di aggiornamento",
  "settings.updates.status": "Stato",
  "settings.updates.checking": "Controllo degli aggiornamenti…",
  "settings.updates.upToDate": "Aggiornato",
  "settings.updates.ready": "Psyche {version} è pronto",
  "settings.updates.readyRequired": "Psyche {version} è pronto (obbligatorio)",
  "settings.updates.refused": "Aggiornamento rifiutato: {reason}",
};
