import type { Catalogue } from "../../index.ts";

/** Failure messages for user actions (fr); merged into `../fr.ts`. */
export const actionErrors: Partial<Catalogue> = {
  "actionError.exportPerson": "Impossible d'exporter les données de cette personne ({reason}).",
  "actionError.revokeGrant":
    "Impossible de révoquer cette autorisation ({reason}). Elle reste active.",
  "actionError.reindex": "Impossible de reconstruire l'index de recherche ({reason}).",
  "actionError.rerun": "Impossible de relancer cette automatisation ({reason}).",
  "actionError.stopResearch": "Impossible d'arrêter la recherche ({reason}). Elle se poursuit.",
  "actionError.unmute": "Impossible de réactiver les rappels ({reason}).",
  "actionError.language": "Impossible de changer la langue ({reason}).",
  "actionError.transcriptMode":
    "Impossible de changer le niveau de détail de la transcription ({reason}).",
  "actionError.screenAskDestination":
    "Impossible de changer la destination des questions sur l'écran ({reason}).",
  "actionError.stopVirtualScreen":
    "Impossible d'arrêter l'écran virtuel ({reason}). Il tourne peut-être encore.",
  "actionError.takeOver": "Impossible de prendre le contrôle de l'écran virtuel ({reason}).",
};
