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
};
