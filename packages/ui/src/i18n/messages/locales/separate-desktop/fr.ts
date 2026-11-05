import type { Catalogue } from "../../index.ts";

/** Settings > Computer use > Separate desktop (fr); merged into `../fr.ts`. */
export const separateDesktop: Partial<Catalogue> = {
  "settings.separateDesktop.title": "Bureau séparé",
  "settings.separateDesktop.description":
    "Un bureau privé dans un conteneur, avec ses propres apps et fichiers. Il ne voit que les dossiers que vous partagez pour une tâche, n'a pas d'internet sauf si vous l'autorisez pour cette tâche, et s'arrête quand la tâche se termine.",
  "settings.separateDesktop.state.off": "À l'arrêt",
  "settings.separateDesktop.state.starting": "Démarrage",
  "settings.separateDesktop.state.running": "En cours",
  "settings.separateDesktop.state.stopping": "Arrêt en cours",
  "settings.separateDesktop.state.failed": "Démarrage impossible",
  "settings.separateDesktop.engine": "Moteur de conteneurs : {engine}",
  "settings.separateDesktop.rootful":
    "Ce moteur de conteneurs s'exécute en root. Utilisez Podman sans root pour le bureau séparé.",
  "settings.separateDesktop.memory": "Limite de mémoire",
  "settings.separateDesktop.memoryHint":
    "La mémoire maximale que le bureau séparé peut utiliser pendant son exécution.",
  "settings.separateDesktop.memoryOption": "{gb} Go",
  "settings.separateDesktop.shares": "Dossiers partagés : {names}",
  "settings.separateDesktop.internet": "Internet est activé pour cette tâche",
  "settings.separateDesktop.reset": "Réinitialiser le bureau séparé",
  "settings.separateDesktop.resetHint":
    "Supprime son conteneur et tout ce qui y est enregistré. Les dossiers que vous avez partagés ne sont pas touchés.",
  "blocks.folder.sd.explain.ro":
    "{persona} veut laisser le bureau séparé lire les fichiers d'un dossier.",
  "blocks.folder.sd.explain.rw":
    "{persona} veut laisser le bureau séparé lire et modifier les fichiers d'un dossier. Les programmes du bureau séparé peuvent y modifier des fichiers, et les changements apparaissent sur cet ordinateur.",
  "blocks.folder.sd.scope":
    "Le bureau séparé voit ce dossier pour cette tâche seulement. Rien d'autre sur cet ordinateur n'est partagé, et aucun autre outil de cet ordinateur n'obtient le dossier.",
  "blocks.folder.sd.scope.once": "Cette tâche seulement",
  "settings.separateDesktop.limitMemory": "La limite de mémoire n'est pas appliquée sur ce système",
  "settings.separateDesktop.limitPids": "La limite de processus n'est pas appliquée sur ce système",
  "blocks.details.sdUnverified":
    "Le bureau séparé ne peut pas confirmer que cette page est bien {origin}. Continuez seulement si vous faites confiance à l'endroit où la tâche vous a menés.",
  "blocks.details.sdFiles": "Fichiers",
  "blocks.details.sdAlsoChanges":
    "Cette tâche peut aussi modifier {folder} et en envoyer des fichiers.",
};
