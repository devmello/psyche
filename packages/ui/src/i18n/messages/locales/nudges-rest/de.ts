import type { Catalogue } from "../../index.ts";

/** Completed nudges strings (de); merged into `../de.ts`. */
export const nudgesRest: Partial<Catalogue> = {
  "nudges.kind": "In Kontakt bleiben",
  "nudges.draftReply": "Antwort entwerfen",
  "nudges.draftMessage": "Nachricht entwerfen",
  "nudges.snooze": "Zurückstellen",
  "nudges.snoozeWeek": "Für eine Woche",
  "nudges.snoozeMonth": "Für einen Monat",
  "nudges.mutePerson": "Nicht diese Person",
  "nudges.done": "Erledigt",
  "nudges.overdue": "Überfällig",
  "nudges.moreActions": "Weitere Möglichkeiten zum Weglegen: {name}",
  "nudges.result.done": "Als erledigt markiert.",
  "nudges.result.snooze_week": "Für eine Woche zurückgestellt.",
  "nudges.result.snooze_month": "Für einen Monat zurückgestellt.",
  "nudges.result.mute_person":
    "Keine Erinnerungen mehr für {name}. Du kannst sie auf der Seite der Person wieder einschalten.",
  "nudges.gone": "Hier ist nichts mehr zu tun.",
  "nudges.failed": "Das wurde nicht gesichert: {reason}",
  "nudges.draft.unanswered":
    "Hilf mir, {name} zu antworten. Die letzte {channel, select, mail {E-Mail} other {Nachricht}} an mich kam vor {days} Tagen und ich habe nicht geantwortet. Sieh dir die Unterhaltung an und entwirf dann eine kurze Antwort, die ich lesen kann. Sende nichts.",
  "nudges.draft.drift":
    "Ich habe schon länger nicht mehr mit {name} gesprochen. Entwirf eine kurze, herzliche Nachricht, mit der ich mich melden kann. Sende nichts.",
  "nudges.draft.birthday":
    "Der besondere Tag von {name} steht bald an ({date}). Entwirf eine kurze, herzliche Nachricht, die ich senden könnte. Sende nichts.",
  "nudges.draft.promise":
    "{text} Hilf mir beim Nachfassen: Entwirf eine kurze Nachricht an {name} dazu. Sende nichts.",
  "nudges.starters.title": "Gesprächsthemen",
  "nudges.draft.starters":
    "Dinge, die ich ansprechen könnte, aus dem, was Psyche gespeichert hat (nutze nur diese und erfinde nichts dazu):",
  "nudges.settings.phrasing": "Vorschläge mit meinem Modell umformulieren",
  "nudges.settings.phrasingHint":
    "Nutzt das Modell, das du für das Gedächtnis „Alles“ gewählt hast, um sie freundlicher zu formulieren. Standardmäßig aus.",
  "nudges.person.title": "In Kontakt bleiben",
  "nudges.person.none": "Nichts nachzufassen.",
  "nudges.person.muted": "Erinnerungen für {name} sind aus.",
  "nudges.person.unmute": "Erinnerungen wieder einschalten",
  "nudges.settings.title": "In Kontakt bleiben",
  "nudges.settings.description":
    "Sanfte Erinnerungen an Menschen, zu denen der Kontakt eingeschlafen ist, an Geburtstage und an Versprechen, die du gegeben hast.",
  "nudges.settings.enabled": "Erinnere mich daran, in Kontakt zu bleiben",
  "nudges.settings.enabledHint":
    "Bis zu drei in deiner Morgenübersicht und leise Feed-Karten. Es wird nie etwas für dich gesendet.",
  "nudges.settings.sensitivity": "Wie oft",
  "nudges.settings.sensitivityHint": "Wie lange eine Nachricht wartet, bevor Psyche etwas sagt.",
  "nudges.settings.low": "Sanft",
  "nudges.settings.normal": "Normal",
  "nudges.settings.high": "Eifrig",
  "nudges.settings.quietHours":
    "Karten warten die Ruhezeiten ab, die unter Einstellungen → Allgemein → Mitteilungen festgelegt sind.",
  "nudges.consent.title": "Beziehungs-Erinnerungen einschalten?",
  "nudges.consent.body":
    "Psyche schaut, wann du zuletzt an Personen geschrieben oder von ihnen gehört hast, mit denen du korrespondierst (nur Daten, nicht der Inhalt), sowie auf bestätigte Geburtstage und Versprechen, die du in eigenen Worten gegeben hast.",
  "nudges.consent.rules":
    "Ausgeschlossene Personen tauchen nie auf, sensible Fakten werden nie verwendet, und eine Erinnerung ist ein schlichter Satz mit einem Namen und einer Anzahl von Tagen. Mit „Nicht diese Person“ kannst du jeden stummschalten und das Ganze jederzeit ausschalten.",
  "nudges.consent.confirm": "Einschalten",
  "nudges.consent.cancel": "Nicht jetzt",
};
