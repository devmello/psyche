import type { Catalogue } from "../../index.ts";

/** Completed memoryWork strings (de); merged into `../de.ts`. */
export const memoryWorkRest: Partial<Catalogue> = {
  "memoryWork.title": "Arbeit",
  "memoryWork.description":
    "Was {persona} für dich im Blick behält: Projekte, To-dos mit Frist und wo du aufgehört hast.",
  "memoryWork.loadLabel": "Arbeitsgedächtnis",
  "memoryWork.enabled.title": "Arbeit im Gedächtnis",
  "memoryWork.enabled.label": "Meine Arbeit verfolgen",
  "memoryWork.enabled.hint":
    "Führt ein To-do für alles mit Frist, wie es läuft und wo du aufgehört hast. Aus, bis du Ja sagst.",
  "memoryWork.enabled.off":
    "Einschalten, um Erinnerungslisten und Ordner zu wählen und Erinnerungen einzurichten.",
  "memoryWork.consent.title": "Deine Arbeit im Gedächtnis verfolgen",
  "memoryWork.consent.body":
    "{persona} führt ein To-do für alles mit Frist (Miete, einen Laborbericht, eine Board-Präsentation) und hält fest, wie es läuft und wo du aufgehört hast.",
  "memoryWork.consent.reads": "Was gelesen wird",
  "memoryWork.consent.r1": "Erinnerungslisten, die du auswählst, und deine eigenen Kalender",
  "memoryWork.consent.r2": "Dateien in Ordnern, die du mit einem Projekt verknüpfst",
  "memoryWork.consent.r3":
    "Deine gesendeten Mails und Mails in Threads, die du verknüpfst, und deine Chats mit {persona}",
  "memoryWork.consent.keeps": "Was gewährleistet bleibt",
  "memoryWork.consent.k1":
    "Nichts verlässt diesen Mac. Daten und Status werden per Code ermittelt.",
  "memoryWork.consent.k2": "Text von anderen Personen ändert nie eine Frist oder einen Status.",
  "memoryWork.consent.k3":
    "Arbeit erscheint auf Home und in deiner Tagesübersicht. Ändere das unter „Wo das Gedächtnis erscheint“.",
  "memoryWork.consent.cancel": "Nicht jetzt",
  "memoryWork.consent.confirm": "Einschalten",
  "memoryWork.lists.title": "Erinnerungslisten",
  "memoryWork.lists.description":
    "Eine Erinnerung mit Fälligkeitsdatum in einer verfolgten Liste wird zu einem To-do im gewählten Projekt. Andere Listen bleiben unberührt. Nur Listen, die du unter „Verbindungen“ als deine markierst, können Dinge als erledigt markieren.",
  "memoryWork.lists.none": "Nicht verfolgt",
  "memoryWork.lists.pick": "Projekt für {list}",
  "memoryWork.lists.missing": "Eine Liste, die es in Erinnerungen nicht mehr gibt",
  "memoryWork.lists.shared": "Geteilte Liste",
  "memoryWork.lists.empty": "Noch keine Erinnerungslisten.",
  "memoryWork.lists.noProjects":
    "Lege auf der Seite „Gedächtnis“ ein Projekt an und wähle es dann hier.",
  "memoryWork.lists.openMemory": "Gedächtnis öffnen",
  "memoryWork.lists.loading": "Deine Erinnerungslisten werden gelesen …",
  "memoryWork.folders.title": "Ordner",
  "memoryWork.folders.anchored": "Nur mit einem Projekt verknüpfte Ordner",
  "memoryWork.folders.anchoredHint":
    "Verknüpfe einen Ordner von der Seite eines Projekts. Passt der Name eines Ordners zu einem Projekt, schlägt {persona} ihn vor.",
  "memoryWork.folders.all": "Jeder Ordner, den {persona} lesen kann, nach Namen zugeordnet",
  "memoryWork.folders.allHint":
    "Ein Ordner, dessen Name zu einem Projekt passt, wird ohne Nachfrage verknüpft. Gelesen werden nur Namen und Daten.",
  "memoryWork.remind.title": "Erinnerungen, damit Dinge fertig werden",
  "memoryWork.remind.description":
    "Mitteilungen sind aus, bis du sie einschaltest. Sie kommen nie in den Ruhezeiten.",
  "memoryWork.remind.enabled": "Mich erinnern, was morgen fällig ist",
  "memoryWork.remind.enabledHint":
    "Eine Mitteilung pro Tag zur Zeit des Abendrückblicks, für Dinge, die in den nächsten {hours, plural, one {# Stunde} other {# Stunden}} fällig sind.",
  "memoryWork.remind.hours": "Wie weit im Voraus gesucht wird",
  "memoryWork.remind.hoursOption": "{hours, plural, one {# Stunde} other {# Stunden}}",
  "memoryWork.remind.at": "Wann",
  "memoryWork.remind.atWrapup": "Zur Zeit deines Abendrückblicks, {time}",
  "memoryWork.remind.atHint":
    "Wird unter „Täglich“ festgelegt. Titel erscheinen nur bei Dingen, die du selbst hinzugefügt hast.",
  "memoryWork.remind.openDaily": "Täglich öffnen",
  "memoryWork.remind.dayOf": "Mir morgens auch sagen, was heute fällig ist",
  "memoryWork.remind.dayOfHint":
    "Eine zweite Mitteilung nach der Morgenübersicht: „Heute fällig: …“.",
  "memoryWork.remind.needsWrapup":
    "Der Abendrückblick ist aus, daher wird nichts gesendet. Schalte ihn ein, um das zu erhalten.",
  "memoryWork.remind.needsBrief":
    "Die Morgenübersicht ist aus, daher wird nichts gesendet. Schalte sie ein, um das zu erhalten.",
  "memoryWork.remind.turnOnWrapup": "Abendrückblick einschalten",
  "memoryWork.remind.turnOnBrief": "Morgenübersicht einschalten",
};
