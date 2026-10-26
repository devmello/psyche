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
  "canvas.map": "Mappa",
  "map.label": "Mappa: {title}",
  "map.untitled": "Mappa",
  "map.list": "Luoghi",
  "map.openLink": "Apri link",
  "map.empty": "Nessun luogo da mostrare.",
  "map.tilesOff":
    "I riquadri della mappa sono disattivati nelle Impostazioni. Viene mostrato l’elenco.",
  "map.tilesFailed": "Impossibile caricare la mappa. Viene mostrato l’elenco.",
  "map.showMap": "Mostra mappa",
  "map.showList": "Mostra elenco",
  "map.card": "Mappa: {title}",
  "map.meta": "{count, plural, one {# luogo} other {# luoghi}} · {date}",
  "map.openCanvas": "Apri nel canvas",
  "map.invalid": "Impossibile leggere questa mappa.",
  "map.gesture.windows": "Usa Ctrl + scorrimento per ingrandire la mappa",
  "map.gesture.mac": "Usa ⌘ + scorrimento per ingrandire la mappa",
  "map.gesture.mobile": "Usa due dita per spostare la mappa",
  "settings.map.title": "Mappe",
  "settings.map.privacy":
    "Mostrare una mappa chiede a un server di riquadri l’area che guardi, quindi quel server può sapere più o meno dove guardi. Disattiva i riquadri per vedere i luoghi solo come elenco, oppure usa un tuo server. Le richieste passano dal tuo Gateway, quindi il server di riquadri vede il Gateway, non il tuo dispositivo.",
  "settings.map.tiles": "Mostra i riquadri della mappa",
  "settings.map.tilesHint": "Disattivato mostra i luoghi come elenco senza richieste di mappa.",
  "settings.map.style": "URL di stile del server di riquadri",
  "settings.map.styleHint":
    "Un URL di stile JSON MapLibre, ad esempio del tuo server. Vuoto usa i riquadri gratuiti di OpenFreeMap (solo https; http per localhost).",
  "settings.map.styleDark": "URL di stile (scuro)",
  "settings.map.styleDarkHint":
    "Facoltativo. Vuoto usa lo stile sopra anche in modalità scura, oppure lo stile scuro di OpenFreeMap.",
};
