import type { Catalogue } from "../../index.ts";

/** Failure messages for user actions (de); merged into `../de.ts`. */
export const actionErrors: Partial<Catalogue> = {
  "actionError.exportPerson": "Die Daten dieser Person konnten nicht exportiert werden ({reason}).",
  "actionError.revokeGrant":
    "Diese Freigabe konnte nicht widerrufen werden ({reason}). Sie gilt weiterhin.",
  "actionError.reindex": "Der Suchindex konnte nicht neu aufgebaut werden ({reason}).",
  "actionError.rerun": "Diese Automation konnte nicht erneut gestartet werden ({reason}).",
  "actionError.stopResearch":
    "Die Recherche konnte nicht gestoppt werden ({reason}). Sie läuft weiter.",
  "actionError.unmute": "Hinweise konnten nicht wieder eingeschaltet werden ({reason}).",
  "actionError.language": "Die Sprache konnte nicht geändert werden ({reason}).",
  "actionError.transcriptMode":
    "Die Detailstufe des Verlaufs konnte nicht geändert werden ({reason}).",
  "actionError.screenAskDestination":
    "Das Ziel für Bildschirmfragen konnte nicht geändert werden ({reason}).",
  "actionError.stopVirtualScreen":
    "Der virtuelle Bildschirm konnte nicht gestoppt werden ({reason}). Er läuft möglicherweise noch.",
  "actionError.takeOver": "Der virtuelle Bildschirm konnte nicht übernommen werden ({reason}).",
};
