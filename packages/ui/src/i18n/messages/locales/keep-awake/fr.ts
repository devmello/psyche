import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (fr); merged into `../fr.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "Garder cet ordinateur éveillé",
  "settings.daily.keepAwake.hint":
    "Pendant qu'une tâche programmée s'exécute, cet ordinateur ne se met pas en veille avant la fin. L'écran peut toujours s'éteindre.",
  "settings.key.scheduled.keepAwake":
    "Garder cet ordinateur éveillé pendant les tâches programmées",
  "scheduled.history.retryingAt": "Nouvelle tentative à {time}",
  "scheduled.history.retry": "Tentative {n} sur 3",
  "scheduled.history.failedAfterRetries": "Échec après {n} nouvelles tentatives",
};
