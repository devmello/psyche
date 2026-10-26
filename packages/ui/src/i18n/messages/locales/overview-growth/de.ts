import type { Catalogue } from "../../index.ts";

/** Overview Growth and People & projects strings (de); merged into `../de.ts`. */
export const overviewGrowth: Partial<Catalogue> = {
  "overview.meta.7d": "Letzte 7 Tage",
  "overview.meta.30d": "Letzte 30 Tage",
  "overview.meta.all": "Gesamte Zeit",
  "overview.growth.loading": "Wachstum wird geladen",
  "overview.growth.loadFailed": "Wachstum konnte nicht geladen werden",
  "overview.growth.empty": "In diesem Zeitraum wurde noch nichts gelernt.",
  "overview.growth.counts": "Lektionen in diesem Zeitraum",
  "overview.growth.learned": "{n, plural, one {# Lektion gelernt} other {# Lektionen gelernt}}",
  "overview.growth.refined": "{n, plural, one {# verfeinert} other {# verfeinert}}",
  "overview.growth.confirmed": "{n, plural, one {# bestätigt} other {# bestätigt}}",
  "overview.growth.forgotten": "{n, plural, one {# vergessen} other {# vergessen}}",
  "overview.growth.milestones": "Meilensteine",
  "overview.growth.seeAll": "Alle Lektionen ansehen",
  "overview.growth.sheetTitle": "Was {agent} gelernt hat",
  "overview.growth.evidenceTitle": "Ereignisse hinter „{metric}“",
  "overview.growth.card.thisWeek": "Lektionen dieser Woche ({n})",
  "overview.growth.card.week": "Lektionen der Woche vom {date} ({n})",
  "overview.growth.card.review": "Ansehen",
  "overview.growth.card.sheetTitle": "Was {agent} diese Woche gelernt hat",
  "overview.growth.card.sheetDescription":
    "Behalte, bearbeite oder vergiss, was {agent} aufgeschnappt hat.",
  "overview.people.loading": "Personen und Projekte werden geladen",
  "overview.people.loadFailed": "Personen und Projekte konnten nicht geladen werden",
  "overview.people.paused":
    "Das Personen-und-Projekte-Netz ist pausiert, daher wird nichts erfasst. Schalte es in den Einstellungen ein, um es hier zu sehen.",
  "overview.people.empty":
    "In diesem Zeitraum noch niemand. Personen und Projekte erscheinen hier, sobald {agent} für dich mit ihnen arbeitet.",
  "overview.people.map": "Karte der Personen und Projekte",
  "overview.people.mapHint":
    "Mit den Pfeiltasten wechselst du zwischen Personen und Projekten, die meisten Interaktionen zuerst. Eingabe öffnet eines.",
  "overview.people.caption":
    "Näher bei dir heißt: jünger. Größer heißt: mehr Interaktionen. Kreise sind Personen, Quadrate sind Projekte und Organisationen.",
  "overview.people.you": "Du",
  "overview.people.ring.0": "Diese Woche",
  "overview.people.ring.1": "Diesen Monat",
  "overview.people.ring.2": "Früher",
  "overview.people.kind.person": "Person",
  "overview.people.kind.org": "Organisation",
  "overview.people.kind.project": "Projekt",
  "overview.people.kind.place": "Ort",
  "overview.people.interactions": "{n, plural, one {# Interaktion} other {# Interaktionen}}",
  "overview.people.openLoops": "{n, plural, one {# offener Punkt} other {# offene Punkte}}",
  "overview.people.last": "Letzte Interaktion {when}",
  "overview.people.node": "{name}, {kind}. {interactions}. Letzte Interaktion {when}. {loops}.",
  "overview.people.detailHint":
    "Zeige mit der Maus oder dem Fokus auf eine Person oder ein Projekt, um Details zu sehen.",
  "overview.people.counts":
    "{people, plural, one {# Person} other {# Personen}} · {projects, plural, one {# Projekt} other {# Projekte}} · {loops, plural, one {# offener Punkt} other {# offene Punkte}}",
  "overview.people.ranked": "{name} {n}",
  "overview.people.showList": "Als Liste anzeigen",
  "overview.people.showMap": "Karte anzeigen",
  "overview.people.seeAll": "Alle ansehen",
  "overview.people.list": "Personen und Projekte, die meisten Interaktionen zuerst",
  "overview.people.table.name": "Name",
  "overview.people.table.kind": "Art",
  "overview.people.table.interactions": "Interaktionen",
  "overview.people.table.last": "Letzte Interaktion",
  "overview.people.table.loops": "Offene Punkte",
};
