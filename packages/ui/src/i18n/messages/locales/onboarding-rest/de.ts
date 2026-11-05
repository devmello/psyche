import type { Catalogue } from "../../index.ts";

/** Completed onboarding strings (de); merged into `../de.ts`. */
export const onboardingRest: Partial<Catalogue> = {
  "onboarding.stepCount": "{n, number} von {total, number}",
  "onboarding.connectors.onThisMac": "Auf diesem Mac",
  "onboarding.connectors.onThisMacHint":
    "Jede App bittet macOS beim Verbinden einzeln um Erlaubnis.",
  "onboarding.connectors.connectApps":
    "{n, plural, =0 {Apps verbinden} one {# App verbinden} other {# Apps verbinden}}",
  "onboarding.connectors.connecting": "{name} wird verbunden",
  "onboarding.connectors.accounts": "Konten",
  "onboarding.step.memory": "Gedächtnis und tägliche Gewohnheiten",
  "onboarding.about.lead":
    "Ein paar Fakten, damit Psyche dich von Anfang an kennt. Alles hier ist optional und steht in USER.md, das du jederzeit bearbeiten kannst.",
  "onboarding.about.name": "Dein Name",
  "onboarding.about.nameHint": "Wie soll Psyche dich nennen?",
  "onboarding.about.timeZone": "Zeitzone",
  "onboarding.about.timeZoneHint": "Europe/Berlin",
  "onboarding.about.work": "Arbeit oder Studium",
  "onboarding.about.workHint": "Was du machst, in wenigen Worten",
  "onboarding.about.city": "Wohnort",
  "onboarding.about.cityHint": "Wo du dich meistens aufhältst",
  "onboarding.memory.lead":
    "Schon ein Profil in ChatGPT oder Claude? Füge den Gedächtnis-Export ein oder die Antwort auf „Was weißt du über mich?“. Du prüfst alles, bevor es gesichert wird.",
  "onboarding.memory.unavailable":
    "Das Importieren ist in diesem Fenster nicht verfügbar. Du kannst es später unter „Seele“ tun.",
  "onboarding.memory.format": "Woher es stammt",
  "onboarding.memory.format.chatgpt": "ChatGPT",
  "onboarding.memory.format.claude": "Claude",
  "onboarding.memory.format.text": "Anderer Text",
  "onboarding.memory.paste": "Gedächtnistext",
  "onboarding.memory.placeholder": "Hier einfügen oder eine .txt-, .md- oder .json-Datei hochladen",
  "onboarding.memory.upload": "Datei hochladen",
  "onboarding.memory.review": "Prüfen",
  "onboarding.memory.found":
    "{n, number} Einträge zur Prüfung gefunden ({skipped, number} übersprungen). Entferne den Haken bei allem, was nicht bleiben soll.",
  "onboarding.memory.items": "Zu importierende Einträge",
  "onboarding.memory.flagged": "Klingt wie eine Anweisung",
  "onboarding.memory.edit": "Zurück zum Text",
  "onboarding.memory.save": "{n, number} im Gedächtnis sichern",
  "onboarding.memory.saved": "{n, number} Einträge im Gedächtnis gesichert.",
  "onboarding.memory.failed": "Das hat nicht geklappt ({reason}).",
  "onboarding.habits.lead":
    "Kurze Karten auf dem Home-Bildschirm, morgens und abends. Psyche liest nur; ohne deine Genehmigung wird nichts gesendet.",
  "onboarding.habits.brief": "Tagesübersicht",
  "onboarding.habits.briefHint": "Dein Tag, jeden Werktagmorgen.",
  "onboarding.habits.wrapup": "Abendrückblick",
  "onboarding.habits.wrapupHint": "Was erledigt wurde und was auf morgen rückt.",
  "onboarding.habits.followups": "Nachfassen verfolgen",
  "onboarding.habits.followupsHint": "Bemerkt Antworten, auf die du noch wartest.",
  "onboarding.rerun.title": "Erneut einrichten",
  "onboarding.rerun.description":
    "Gehe die Ersteinrichtung noch einmal durch. Bereits erledigte Schritte werden übersprungen.",
  "onboarding.rerun.button": "Einrichtung erneut ausführen",
  "onboarding.step.you": "Du und dein Agent",
  "onboarding.step.stuff": "Deine Sachen",
  "onboarding.step.safety": "Sicherheit",
  "onboarding.you.lead": "Alles auf dieser Seite ist optional, und du kannst es später ändern.",
  "onboarding.you.agent": "Dein Agent",
  "onboarding.you.customize": "Aussehen anpassen",
  "onboarding.you.more": "Mehr über dich",
  "onboarding.memory.habitsLead":
    "Wähle, was {name} jeden Tag tut und was es im Gedächtnis behält. Alles lässt sich in den Einstellungen ändern.",
  "onboarding.memory.bring": "Gedächtnis aus ChatGPT oder Claude übernehmen",
  "onboarding.habits.title": "Jeden Tag",
  "onboarding.work.title": "Arbeit und To-dos",
  "onboarding.work.hint":
    "Führt ein To-do für alles mit Frist: Rechnungen, Miete, Steuern, Verlängerungen, Arbeitsfristen, Hausaufgaben. {persona} liest nur die Listen und Ordner, die du wählst. Aus, bis du Ja sagst.",
  "onboarding.work.remindHint":
    "Wird mit deinem Abendrückblick gesendet. Titel erscheinen nur bei Dingen, die du selbst hinzugefügt hast.",
  "onboarding.work.later":
    "Lege unter Einstellungen → Gedächtnis → Arbeit fest, welche Erinnerungslisten und Ordner zählen.",
  "onboarding.people.title": "Personen",
  "onboarding.people.label": "Personen in meine Übersicht aufnehmen",
  "onboarding.people.hint":
    "Fakten über Menschen, die du kennst, und mit wem du in Kontakt bleiben solltest. Aus, außer du schaltest es ein.",
  "onboarding.people.needsBrief":
    "Die Morgenübersicht ist aus, daher erscheinen Personen noch nirgends. Schalte sie ein, um sie zu sehen.",
  "onboarding.safety.lead":
    "Wie Genehmigungen dich erreichen und was von selbst läuft. Der Zugriff auf deine Dateien, Apps und deinen Bildschirm wird hier nicht abgefragt: {name} fragt im Chat, wenn es ihn zum ersten Mal braucht.",
  "onboarding.safety.touchId": "Touch ID für Genehmigungen",
  "onboarding.safety.touchId.checking": "Der Mac-Helper wird geprüft …",
  "onboarding.safety.touchId.again": "Erneut prüfen",
  "onboarding.safety.touchId.set": "Einrichten",
  "onboarding.safety.touchId.setHint":
    "Genehmigungen, die dich brauchen, verlangen deinen Fingerabdruck.",
  "onboarding.safety.touchId.starting": "Der Mac-Helper startet noch. Prüfe gleich erneut.",
  "onboarding.safety.touchId.noKey": "Der Mac-Helper hat keinen Touch-ID-Schlüssel ({reason}).",
  "onboarding.safety.touchId.register": "Diesen Schlüssel registrieren",
  "onboarding.safety.touchId.hint":
    "Registriere den Schlüssel des Mac-Helpers einmal, damit Touch ID Genehmigungen bestätigen kann.",
  "onboarding.safety.notifications": "Mitteilungen",
  "onboarding.safety.asks":
    "Erlaubst du {name}, Befehle auf diesem Mac auszuführen, laufen solche, die nur lesen, wie ls oder cat, ohne Karte. Alles andere fragt dich zuerst.",
  "onboarding.safety.sandbox": "Eine Sandbox für Befehle einrichten",
  "onboarding.safety.optional": "Optional",
  "onboarding.done.on": "An",
  "onboarding.done.off": "Aus",
  "onboarding.done.daily": "Täglich",
  "onboarding.done.work": "Arbeitsverfolgung",
  "onboarding.done.people": "Personen in deiner Übersicht",
  "onboarding.done.touchId": "Touch ID",
  "onboarding.done.touchIdSet": "Schlüssel registriert",
  "onboarding.done.touchIdNot": "Noch nicht registriert",
  "onboarding.done.modelKept": "Unverändert",
  "onboarding.done.try": "Als Nächstes ausprobieren",
  "onboarding.done.try.search":
    "Stelle in der Suche (⌘K) eine Frage. Die Antwort zeigt, woher in deinem Leben sie stammt.",
  "onboarding.done.try.home": "Öffne Home. „Aufholen“ listet auf, was du hast liegen lassen.",
  "onboarding.done.try.canDo": "Öffne „Was kannst du?“ im Zahnrad-Menü für fertige Aufgaben.",
};
