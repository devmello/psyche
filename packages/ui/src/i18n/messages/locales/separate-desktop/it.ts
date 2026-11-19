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
  "blocks.folder.sd.explain.ro":
    "{persona} vuole permettere al desktop separato di leggere i file di una cartella.",
  "blocks.folder.sd.explain.rw":
    "{persona} vuole permettere al desktop separato di leggere e modificare i file di una cartella. I programmi nel desktop separato possono modificare i file lì, compresi quelli che eseguono programmi su questo computer, come le impostazioni di git e gli script, e le modifiche compaiono su questo computer.",
  "blocks.folder.sd.scope":
    "Il desktop separato vede questa cartella solo per questa attività. Nient'altro su questo computer viene condiviso e nessun altro strumento di questo computer riceve la cartella.",
  "blocks.folder.sd.scope.once": "Solo questa attività",
  "settings.separateDesktop.limitMemory": "Il limite di memoria non è applicato su questo sistema",
  "settings.separateDesktop.limitPids": "Il limite dei processi non è applicato su questo sistema",
  "blocks.details.sdUnverified":
    "Il desktop separato non può confermare che questa pagina sia davvero {origin}. Continua solo se ti fidi del luogo a cui l'attività ti ha portato.",
  "blocks.details.sdFiles": "File",
  "blocks.details.sdAlsoChanges":
    "Questa attività può anche modificare {folder} e inviare file da lì.",
};
