import type { Catalogue } from "../../index.ts";

/** Memory map strings (it); merged into `../it.ts`. */
export const memoryMap: Partial<Catalogue> = {
  "memory.page.view.map": "Mappa",
  "memory.map.title": "Mappa della memoria",
  "memory.map.canvasLabel":
    "Mappa di {nodes, plural, one {# elemento} other {# elementi}} con {links, plural, one {# collegamento} other {# collegamenti}}. Trascina per spostare, scorri o pizzica per zoomare, frecce per muoverti.",
  "memory.map.loading": "Caricamento della mappa",
  "memory.map.loadFailed": "Impossibile caricare la mappa della memoria.",
  "memory.map.empty":
    "Ancora niente da mappare. Man mano che Psyche conosce le persone, i progetti e gli argomenti della tua vita, compaiono qui, collegati.",
  "memory.map.sparse":
    "Per ora ci sono pochi collegamenti. Ne compaiono altri quando le persone condividono con te progetti, riunioni e conversazioni.",
  "memory.map.truncated": "Sono mostrati i {shown} più importanti su {total}.",
  "memory.map.search": "Cerca sulla mappa",
  "memory.map.search.placeholder": "Cerca una persona, un progetto o un argomento",
  "memory.map.search.results": "Risultati",
  "memory.map.search.none": "Niente sulla mappa corrisponde a «{q}».",
  "memory.map.filters": "Mostra sulla mappa",
  "memory.map.group.people": "Persone",
  "memory.map.group.projects": "Progetti",
  "memory.map.group.events": "Eventi",
  "memory.map.group.topics": "Argomenti",
  "memory.map.group.other": "Luoghi e organizzazioni",
  "memory.map.quiet":
    "{n, plural, one {# persona senza contatti} other {# persone senza contatti}}",
  "memory.map.kind.person": "Persona",
  "memory.map.kind.org": "Organizzazione",
  "memory.map.kind.project": "Progetto",
  "memory.map.kind.place": "Luogo",
  "memory.map.kind.event": "Evento",
  "memory.map.kind.topic": "Argomento",
  "memory.map.kind.assignment": "Attività",
  "memory.map.edge.works_on": "Lavora a",
  "memory.map.edge.met_in": "Incontrati in",
  "memory.map.edge.co_mentioned": "Citati insieme",
  "memory.map.edge.related": "Correlato",
  "memory.map.legend": "Collegamenti",
  "memory.map.zoomIn": "Ingrandisci",
  "memory.map.zoomOut": "Riduci",
  "memory.map.fit": "Adatta alla vista",
  "memory.map.focus.showing":
    "{name} e {n, plural, =0 {nessuna connessione} one {# connessione} other {# connessioni}}",
  "memory.map.focus.clear": "Mostra tutto",
  "memory.map.card.connections":
    "{n, plural, =0 {Nessun collegamento} one {# collegamento} other {# collegamenti}}",
  "memory.map.card.quiet": "Senza contatti",
  "memory.map.card.private": "Privato",
  "memory.map.card.open": "Apri",
  "memory.map.card.focus": "Concentrati qui",
  "memory.map.card.hint": "Clic per aprire. Maiusc-clic per concentrarti qui.",
  "memory.map.list.label": "Elementi sulla mappa, i più importanti per primi",
};
