import type { Catalogue } from "../../index.ts";

/** Output canvas strings (it); merged into `../it.ts`. */
export const canvas: Partial<Catalogue> = {
  "canvas.chart": "Grafico",
  "canvas.htmlOff":
    "Proviene da contenuti non attendibili, quindi l’anteprima è disattivata. Eseguila solo se ti fidi. Gira in una sandbox senza rete.",
  "canvas.htmlRun": "Esegui",
  "canvas.htmlNoPreview":
    "Questo host non può mostrare l’anteprima HTML; viene mostrato il sorgente.",
  "canvas.label": "Canvas: {title}",
  "canvas.recents": "Risultati recenti",
  "canvas.loading": "Caricamento…",
  "canvas.missing": "Psyche non è riuscito a caricare questo risultato.",
  "canvas.untrusted": "Da contenuti non attendibili",
  "canvas.version": "Versione",
  "canvas.versionOption":
    "v{version} · {author, select, user {tu} specialist {specialista} other {Psyche}} · {time}",
  "canvas.copy": "Copia",
  "canvas.copied": "Copiato",
  "canvas.download": "Scarica",
  "canvas.restore": "Ripristina come nuova versione",
  "canvas.oldVersion": "Versione {version} (sola lettura).",
  "canvas.conflict":
    "È cambiato mentre lo modificavi, quindi la modifica non è stata salvata. Riprova sull’ultima versione.",
  "canvas.saveFailed": "Impossibile salvare: {message}",
};
