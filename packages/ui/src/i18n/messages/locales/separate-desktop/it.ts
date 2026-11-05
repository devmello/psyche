import type { Catalogue } from "../../index.ts";

/** Settings > Computer use > Separate desktop (it); merged into `../it.ts`. */
export const separateDesktop: Partial<Catalogue> = {
  "settings.separateDesktop.title": "Desktop separato",
  "settings.separateDesktop.description":
    "Un desktop privato in un contenitore, con app e file propri. Vede solo le cartelle che condividi per un'attività, non ha internet a meno che tu non lo consenta per quell'attività e si ferma quando l'attività termina.",
  "settings.separateDesktop.state.off": "Non in esecuzione",
  "settings.separateDesktop.state.starting": "Avvio in corso",
  "settings.separateDesktop.state.running": "In esecuzione",
  "settings.separateDesktop.state.stopping": "Arresto in corso",
  "settings.separateDesktop.state.failed": "Impossibile avviare",
  "settings.separateDesktop.engine": "Motore dei contenitori: {engine}",
  "settings.separateDesktop.rootful":
    "Questo motore di contenitori viene eseguito come root. Usa Podman senza root per il desktop separato.",
  "settings.separateDesktop.memory": "Limite di memoria",
  "settings.separateDesktop.memoryHint":
    "La memoria massima che il desktop separato può usare mentre è in esecuzione.",
  "settings.separateDesktop.memoryOption": "{gb} GB",
  "settings.separateDesktop.shares": "Cartelle condivise: {names}",
  "settings.separateDesktop.internet": "Internet è attivo per questa attività",
  "settings.separateDesktop.reset": "Reimposta il desktop separato",
  "settings.separateDesktop.resetHint":
    "Elimina il suo contenitore e tutto ciò che è salvato al suo interno. Le cartelle che hai condiviso non vengono toccate.",
};
