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
  "scheduled.history.cancelRetry": "Annuler la nouvelle tentative",
  "scheduled.history.cancelRetry.aria": "Annuler la nouvelle tentative de l'exécution du {when}",
  "scheduled.history.cancelRetry.failed": "Impossible d'annuler la nouvelle tentative ({reason}).",
  "settings.updates.group": "Mises à jour",
  "settings.updates.hint":
    "Psyche recherche les mises à jour signées et les installe quand vous quittez.",
  "settings.storage.title": "Stockage",
  "settings.storage.hint":
    "Espace disque utilisé par Psyche dans son dossier de données sur cet ordinateur.",
  "settings.storage.total": "Total",
  "settings.storage.clear": "Vider…",
  "settings.storage.cleared": "Vidé. {size} libérés.",
  "settings.storage.clearFailed": "Impossible de vider le stockage ({reason}).",
  "settings.storage.compact.title": "Compacter la base de données",
  "settings.storage.compact.hint":
    "Base de données : {size}, jusqu'à {reclaimable} récupérables. Psyche fait une courte pause pendant l'opération.",
  "settings.storage.compact.button": "Compacter",
  "settings.storage.compact.running": "Compactage…",
  "settings.storage.compact.done": "Compactée en {seconds} s, {size} récupérés.",
  "settings.storage.compact.failed": "Impossible de compacter la base de données ({reason}).",
  "settings.storage.compact.busy": "Psyche est occupé. Réessayez une fois la tâche terminée.",
  "settings.storage.failed": "Impossible de lire l'utilisation du stockage ({reason}).",
  "settings.storage.confirm.title": "Vider les caches et les anciens enregistrements ?",
  "settings.storage.confirm.body":
    "Cela supprime {size} de caches et d'enregistrements du navigateur de plus de 7 jours, avec leurs entrées dans la Bibliothèque. Psyche reconstruit les caches quand il en a besoin. Vos discussions, votre mémoire, les autres fichiers de la Bibliothèque, le coffre et les réglages ne sont pas touchés.",
  "settings.storage.confirm.clear": "Vider",
  "settings.storage.cat.database": "Base de données",
  "settings.storage.cat.memoryIndex": "Index de mémoire",
  "settings.storage.cat.library": "Pièces jointes et Bibliothèque",
  "settings.storage.cat.browserProfiles": "Profils du navigateur",
  "settings.storage.cat.recordings": "Enregistrements",
  "settings.storage.cat.logs": "Journaux",
  "settings.storage.cat.caches": "Caches",
  "settings.storage.cat.other": "Tout le reste",
};
