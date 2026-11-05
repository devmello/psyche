import type { Catalogue } from "../../index.ts";

/** `memory.*` strings (it); merged into `../it.ts`. */
export const memoryRest: Partial<Catalogue> = {
  "memory.page.title": "Memoria",
  "memory.page.soul": "Anima",
  "memory.page.kinds": "Cosa mostrare",
  "memory.page.kind.everything": "Tutto",
  "memory.page.kind.people": "Persone",
  "memory.page.kind.projects": "Progetti",
  "memory.page.kind.due": "Lavori in scadenza",
  "memory.page.kind.events": "Eventi",
  "memory.page.kind.more": "Altro",
  "memory.page.review": "Revisione",
  "memory.page.reviewWaiting": "Revisione, {n} in attesa",
  "memory.page.back": "Torna a {tab}",
  "memory.page.continue": "Continua nella chat",
  "memory.page.continue.prefillWork": "A che punto sono su questo?",
  "memory.page.continue.prefill": "Aggiornami su questo.",
  "memory.page.continue.threadTitle": "Si continua da Memoria",
  "memory.page.continue.source": "Memoria",
  "memory.page.continue.failed": "Impossibile aprire la chat. {reason}",
  "memory.page.seeAll": "Vedi tutto",
  "memory.page.loadFailed": "Impossibile caricare questa parte di Memoria.",
  "memory.page.everything.empty":
    "Ancora nulla di ricordato. Attiva una fonte in Impostazioni → Memoria, oppure dillo a {persona} in chat.",
  "memory.page.everything.review": "Da rivedere",
  "memory.page.everything.reviewCount":
    "{n, plural, one {# fatto aspetta il tuo OK} other {# fatti aspettano il tuo OK}}",
  "memory.page.everything.due": "In scadenza a breve",
  "memory.page.everything.projects": "Progetti attivi",
  "memory.page.everything.people": "Persone con cui sei in contatto",
  "memory.page.everything.events": "In arrivo",
  "memory.page.projects.filter": "Stato",
  "memory.page.projects.empty": "Ancora nessun progetto qui.",
  "memory.page.projects.nothing": "Nessun progetto corrisponde a “{query}”.",
  "memory.page.due.title": "Niente in scadenza",
  "memory.page.due.body":
    "Bollette, rinnovi, scadenze di lavoro e compiti compariranno qui non appena {persona} li terrà d’occhio.",
  "memory.page.events.upcoming": "In arrivo",
  "memory.page.events.other": "Altri eventi",
  "memory.page.events.empty":
    "Nessuna data in arrivo. Compleanni, anniversari ed eventi che confermi compaiono qui.",
  "memory.page.events.when": "{n, plural, =0 {Oggi} =1 {Domani} other {Tra # giorni}}",
  "memory.page.more.place": "Luoghi",
  "memory.page.more.org": "Organizzazioni",
  "memory.page.more.topic": "Argomenti",
  "memory.page.more.empty": "Ancora nessun luogo, organizzazione o argomento.",
};
