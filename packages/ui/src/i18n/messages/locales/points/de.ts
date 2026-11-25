import type { Catalogue } from "../../index.ts";

/** Psyche points (de); merged into `../de.ts`. */
export const points: Partial<Catalogue> = {
  "points.sheet.title": "Durch ein Formular führen",
  "points.sheet.description":
    "Wähle ein Fenster, und Psyche zeigt auf das nächste Feld. Klicken und Tippen übernimmst du.",
  "points.sheet.windows.label": "Fenster",
  "points.sheet.windows.loading": "Fenster werden gesucht…",
  "points.sheet.windows.empty":
    "Keine Fenster zum Zeigen. Öffne das Formular und versuche es noch einmal.",
  "points.sheet.windows.error":
    "Fenster konnten nicht aufgelistet werden. Prüfe, ob Psyche Helper läuft, und versuche es noch einmal.",
  "points.sheet.windows.retry": "Erneut versuchen",
  "points.sheet.window.untitled": "Fenster ohne Titel",
  "points.sheet.window.frontmost": "Vorne",
  "points.refusal.never_app": "Psyche zeigt in dieser App nichts.",
  "points.refusal.fixed_off": "Diese App ist für Psyche tabu.",
  "points.refusal.terminal_or_ide": "Terminals und Code-Editoren sind keine Formulare.",
  "points.refusal.owner_off": "Du hast diese App in den Einstellungen ausgeschaltet.",
  "points.refusal.not_a_window": "Psyche kann dieses Fenster nicht lesen.",
  "points.refusal.permission_missing": "Erlaube Bedienungshilfen, um dieses Fenster zu lesen.",
  "points.sheet.goal.label": "Wofür ist dieses Formular? (optional)",
  "points.sheet.goal.placeholder": "Steuererklärung 2026, gemeinsame Veranlagung",
  "points.sheet.data.provider":
    "Psyche sendet die Feldbeschriftungen und deine Eingaben an {provider}, um dich zu führen – ohne Passwörter sowie Karten-, Bank- und Ausweisnummern.",
  "points.sheet.data.local": "Das bleibt auf diesem Computer.",
  "points.sheet.data.providerFallback": "deinen Modellanbieter",
  "points.sheet.payments":
    "Auf Zahlungsseiten gibt Psyche nur Hinweise. Diese Felder füllst du selbst aus.",
  "points.sheet.permission.hint":
    "Psyche liest das Fenster über die Bedienungshilfen. Erlaube sie für Psyche Helper, um zu starten.",
  "points.sheet.start": "Zeigen starten",
  "points.sheet.starting": "Wird gestartet…",
  "points.sheet.cancel": "Abbrechen",
  "points.sheet.startFailed": "Das Zeigen konnte nicht gestartet werden. Versuche es noch einmal.",
  "points.sheet.session.active": "Psyche zeigt in {app}",
  "points.sheet.session.stop": "Zeigen beenden",
  "points.state.reading": "Formular wird gelesen…",
  "points.state.pointing": "Feld {step} von {of}",
  "points.state.paused": "Pausiert",
  "points.needs.screenRecording.title": "Psyche schauen lassen braucht die Bildschirmaufnahme",
  "points.needs.screenRecording.hint":
    "Psyche sendet ein Bild dieses Fensters nur, wenn du auf „Psyche schauen lassen“ drückst.",
  "points.needs.done": "Fertig",
  "points.offer.button": "Führ mich durch",
  "points.offer.hint": "Psyche zeigt, wohin du schauen sollst. Du klickst und tippst.",
  "points.offer.elsewhere":
    "Starte Psyche points auf dem Computer, auf dem Psyche läuft: Drücke {keys} und wähle „Durch ein Formular führen“.",
  "points.palette.start": "Durch ein Formular führen",
  "points.palette.keywords":
    "psyche points pfeil führen formular ausfüllen steuern visum antrag hilfe",
  "points.settings.title": "Psyche points",
  "points.settings.description":
    "Wähle ein Fenster, und Psyche zeigt auf das nächste Feld. Es klickt und tippt nie.",
  "points.settings.enabledHint":
    "Fügt „Durch ein Formular führen“ zur Befehlspalette und zum Menüleistenmenü hinzu.",
  "settings.key.points.enabled": "Durch Formulare führen",
  "points.card.back": "Zurück",
  "points.card.skip": "Überspringen",
  "points.card.next": "Weiter",
  "points.card.looksWrong": "Sieht falsch aus?",
  "points.card.stuck": "Hängst du fest?",
  "points.card.stuckMissing": "Das habe ich nicht",
  "points.card.stuckUnclear": "Das verstehe ich nicht",
  "points.card.stuckBlocked": "Es lässt mich nicht",
  "points.card.askInPsyche": "In Psyche fragen…",
  "points.card.letLook": "Psyche schauen lassen",
  "points.card.stop": "Stopp",
  "points.card.hideNote": "Notiz ausblenden",
  "points.card.copy": "Kopieren",
  "points.card.selfFill": "Das füllst du selbst aus: {label}",
  "points.card.selfFillPlain": "Das füllst du selbst aus",
  "points.card.payButton": "Diese Schaltfläche bezahlt. Prüfe den Betrag und entscheide selbst.",
  "points.card.unknownValue": "Psyche kennt diesen Wert nicht.",
  "points.card.scrollTo": "Nach unten zu {label} scrollen",
  "points.card.menuBarTitle": "◉ Zeigt: {app}",
  "points.card.stepFormat": "{n}/{total}",
  "points.card.visionBadge": "Nutzt ein Bild dieses Fensters",
  "points.card.followWindow": "Diesem Fenster folgen",
};
