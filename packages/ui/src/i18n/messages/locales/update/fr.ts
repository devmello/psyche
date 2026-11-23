import type { Catalogue } from "../../index.ts";

/** App update strings (fr); merged into `../fr.ts`. */
export const update: Partial<Catalogue> = {
  "shell.update.ready": "Psyche {version} est prêt",
  "shell.update.readyRequired": "Psyche {version} est prêt. Cette mise à jour est obligatoire.",
  "shell.update.restart": "Redémarrer pour mettre à jour",
  "shell.update.dismiss": "Masquer l’avis de mise à jour",
  "settings.updates.status": "État",
  "settings.updates.checking": "Recherche de mises à jour…",
  "settings.updates.upToDate": "À jour",
  "settings.updates.ready": "Psyche {version} est prêt",
  "settings.updates.readyRequired": "Psyche {version} est prêt (obligatoire)",
  "settings.updates.refused": "Mise à jour refusée : {reason}",
  "settings.updates.installFailed":
    "Psyche n’a pas pu installer la mise à jour. Réessayez plus tard.",
};
