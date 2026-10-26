import type { Catalogue } from "../../index.ts";

/** Overview Growth and People & projects strings (it); merged into `../it.ts`. */
export const overviewGrowth: Partial<Catalogue> = {
  "overview.meta.7d": "Ultimi 7 giorni",
  "overview.meta.30d": "Ultimi 30 giorni",
  "overview.meta.all": "Sempre",
  "overview.growth.loading": "Caricamento della crescita",
  "overview.growth.loadFailed": "Impossibile caricare la crescita",
  "overview.growth.empty": "In questo periodo non è stato ancora imparato nulla.",
  "overview.growth.counts": "Lezioni di questo periodo",
  "overview.growth.learned": "{n, plural, one {# lezione appresa} other {# lezioni apprese}}",
  "overview.growth.refined": "{n, plural, one {# perfezionata} other {# perfezionate}}",
  "overview.growth.confirmed": "{n, plural, one {# confermata} other {# confermate}}",
  "overview.growth.forgotten": "{n, plural, one {# dimenticata} other {# dimenticate}}",
  "overview.growth.milestones": "Traguardi",
  "overview.growth.seeAll": "Vedi tutte le lezioni",
  "overview.growth.sheetTitle": "Cosa ha imparato {agent}",
  "overview.growth.evidenceTitle": "Eventi dietro «{metric}»",
  "overview.growth.card.thisWeek": "Lezioni di questa settimana ({n})",
  "overview.growth.card.week": "Lezioni della settimana del {date} ({n})",
  "overview.growth.card.review": "Rivedi",
  "overview.growth.card.sheetTitle": "Cosa ha imparato {agent} questa settimana",
  "overview.growth.card.sheetDescription":
    "Conserva, modifica o dimentica ciò che {agent} ha appreso.",
  "overview.people.loading": "Caricamento di persone e progetti",
  "overview.people.loadFailed": "Impossibile caricare persone e progetti",
  "overview.people.paused":
    "Il grafo di persone e progetti è in pausa, quindi non viene tracciato nulla. Attivalo nelle Impostazioni per vederlo qui.",
  "overview.people.empty":
    "Nessuno per ora in questo periodo. Persone e progetti compaiono qui quando {agent} lavora con loro per te.",
  "overview.people.map": "Mappa di persone e progetti",
  "overview.people.mapHint":
    "Le frecce spostano tra persone e progetti, prima quelli con più interazioni. Invio ne apre uno.",
  "overview.people.caption":
    "Più vicino a te significa più recente. Più grande significa più interazioni. I cerchi sono persone; i quadrati sono progetti e organizzazioni.",
  "overview.people.you": "Tu",
  "overview.people.ring.0": "Questa settimana",
  "overview.people.ring.1": "Questo mese",
  "overview.people.ring.2": "Prima",
  "overview.people.kind.person": "Persona",
  "overview.people.kind.org": "Organizzazione",
  "overview.people.kind.project": "Progetto",
  "overview.people.kind.place": "Luogo",
  "overview.people.interactions": "{n, plural, one {# interazione} other {# interazioni}}",
  "overview.people.openLoops": "{n, plural, one {# impegno aperto} other {# impegni aperti}}",
  "overview.people.last": "Ultima interazione {when}",
  "overview.people.node": "{name}, {kind}. {interactions}. Ultima interazione {when}. {loops}.",
  "overview.people.detailHint":
    "Passa il mouse o il focus su una persona o un progetto per vederne i dettagli.",
  "overview.people.counts":
    "{people, plural, one {# persona} other {# persone}} · {projects, plural, one {# progetto} other {# progetti}} · {loops, plural, one {# impegno aperto} other {# impegni aperti}}",
  "overview.people.ranked": "{name} {n}",
  "overview.people.showList": "Mostra come elenco",
  "overview.people.showMap": "Mostra la mappa",
  "overview.people.seeAll": "Vedi tutto",
  "overview.people.list": "Persone e progetti, prima quelli con più interazioni",
  "overview.people.table.name": "Nome",
  "overview.people.table.kind": "Tipo",
  "overview.people.table.interactions": "Interazioni",
  "overview.people.table.last": "Ultima interazione",
  "overview.people.table.loops": "Impegni aperti",
};
