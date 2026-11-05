import type { Catalogue } from "../../index.ts";

/** Completed misc strings (de); merged into `../de.ts`. */
export const miscRest: Partial<Catalogue> = {
  "common.avatarCount": "{label}, {n, plural, one {# braucht dich} other {# brauchen dich}}",
  "canvas.export": "Exportieren",
  "canvas.exportAs": "Exportieren als …",
  "canvas.exportFailed": "Export fehlgeschlagen: {message}",
  "canvas.loadingEditor": "Editor wird geöffnet …",
  "canvas.invalid":
    "{kind, select, slides {Diese Präsentation} other {Diese Tabelle}} konnte nicht gelesen werden.",
  "book.label": "Tabelle: {title}",
  "book.sheets": "Blätter",
  "book.addSheet": "Blatt hinzufügen",
  "book.newSheet": "Blatt {n}",
  "book.cell": "Zelle {ref}",
  "book.formulaBar": "Wert oder Formel für {ref}",
  "book.hint": "Beginne mit = für eine Formel, zum Beispiel =SUMME(B2:B9).",
  "book.cells": "{count, plural, one {# Zelle} other {# Zellen}}",
  "personData.export": "Alles exportieren …",
  "personData.said": "Vergessen, was die Person gesagt hat …",
  "personData.exclude": "Nichts mehr über die Person lernen …",
  "personData.excludeForget": "Nichts mehr über die Person lernen und vergessen …",
  "personData.title.said": "Vergessen, was {name} gesagt hat?",
  "personData.title.exclude": "Nichts mehr über {name} lernen?",
  "personData.title.exclude_forget": "Nichts mehr über {name} lernen und vergessen?",
  "personData.counts":
    "Das löscht {facts, number} Fakten und {quotes, number} Zitate, die aus den Nachrichten der Person gelernt wurden, sowie {held, number} zurückgehaltene Einträge.",
  "personData.excludeOnly":
    "Ihre Nachrichten werden nicht gelesen, und es wird nichts über sie gelernt. Was bereits bekannt ist, bleibt, bis du es vergisst.",
  "personData.after.said":
    "Die Person, ihre Nachrichten und alles, was du selbst hinzugefügt hast, bleiben.",
  "personData.after.exclude":
    "Du kannst sie unter Einstellungen → Gedächtnis → Datenschutz wieder zulassen.",
  "personData.after.exclude_forget":
    "Du kannst sie unter Einstellungen → Gedächtnis → Datenschutz wieder zulassen, aber was gelöscht wurde, kommt nicht zurück.",
  "personData.confirm.said": "Vergessen, was die Person gesagt hat",
  "personData.confirm.exclude": "Nicht mehr lernen",
  "personData.confirm.exclude_forget": "Beenden und vergessen",
  "personData.done.said": "Vergessen, was {name} gesagt hat.",
  "personData.done.exclude": "Es wird nichts mehr über {name} gelernt.",
  "personData.done.exclude_forget":
    "Es wird nichts mehr über {name} gelernt, und was die Person gesagt hat, wurde vergessen.",
  "memoryBasics.group": "Woraus es lernt",
  "memoryBasics.chats": "Deine Chats",
  "memoryBasics.chatsHint": "Merkt sich, was in deinen Unterhaltungen wichtig ist.",
  "memoryBasics.feedback": "Dein Feedback",
  "memoryBasics.feedbackHint": "Lernt aus Korrekturen, Bearbeitungen und Rückgängig-Aktionen.",
  "memoryBasics.everything": "Mails, Nachrichten und Notizen",
  "memoryBasics.everythingHint":
    "Das Gedächtnis „Alles“ liest sie über Nacht und schlägt Fakten zur Prüfung vor.",
  "memoryBasics.people": "Personen und Projekte",
  "memoryBasics.peopleHint":
    "Führt eine Karte für jede Person und jedes Projekt, mit dem du zu tun hast.",
  "memoryBasics.paused": "Das Gedächtnis ist pausiert.",
  "memoryAdvanced.title": "Erweitert",
  "memoryAdvanced.description":
    "Modelle, Zeitplan, wie abgerufen wird, Verschlüsselung und deine Daten.",
  "memoryAdvanced.recall": "Abruf",
  "memoryAdvanced.data": "Deine Daten",
  "memoryAdvanced.dataHint":
    "Alles, was sich {persona} merkt, exportieren, sichern oder zurücksetzen.",
  "memoryAdvanced.dataOpen": "Datenschutz & Daten öffnen",
  "memoryAdvanced.keeping": "Wie lange Dinge bleiben",
  "memoryAdvanced.keepingPending": "Ungeprüfte Fakten",
  "memoryAdvanced.keepingUntrusted": "Fakten von anderen",
  "memoryAdvanced.keepingQuarantine": "Quarantäne",
  "memoryAdvanced.keepingDays": "{days, plural, one {# Tag} other {# Tage}}",
  "memoryAdvanced.keepingMonths": "{months, plural, one {# Monat} other {# Monate}}",
  "memoryAdvanced.encryption": "Verschlüsselung",
  "memoryPrivacy.title": "Datenschutz",
  "memoryPrivacy.description":
    "Über wen {persona} lernen darf, was es nie behalten darf und wie du es vergessen lässt.",
  "memoryPrivacy.forget": "Vergessen",
  "memoryPrivacy.forgetHint":
    "Entfernen, was eine Quelle geliefert hat, oder alles über Personen und Projekte.",
  "memoryPrivacy.sensitiveSummary": "{n, number} von {total, number} erlaubt",
  "memoryPrivacy.sensitiveChoose": "Themen wählen",
  "meetingRecord.palette": "Meeting aufnehmen …",
  "meetingRecord.title": "Dieses Meeting aufnehmen?",
  "meetingRecord.intro":
    "Sag es allen, bevor du beginnst. Sprich das laut aus oder füge es in den Chat ein. Psyche tritt nie einem Anruf bei und nimmt erst auf, nachdem du bestätigt hast.",
  "meetingRecord.copy": "Kopieren",
  "meetingRecord.copied": "Kopiert",
  "meetingRecord.confirm": "Ich habe es allen gesagt",
  "meetingRecord.cancel": "Abbrechen",
  "meetingRecord.privacy":
    "Das Audio bleibt in deinem Psyche, wird dort in Notizen umgewandelt und nie anderswohin hochgeladen oder für Training verwendet.",
  "meetingRecord.unavailable":
    "Zum Aufnehmen braucht es eine Möglichkeit, Audio in Notizen umzuwandeln (den Mac-Helper), und der ist nicht verbunden.",
  "meetingRecord.micDenied":
    "Psyche kann das Mikrofon nicht nutzen. Erlaube es in den Systemeinstellungen.",
  "meetingRecord.failed": "Psyche konnte dieses Meeting nicht aufnehmen.",
  "meetingRecord.pill": "Meeting wird aufgenommen · {time}",
  "meetingRecord.stop": "Stopp",
  "meetingRecord.stopping": "Wird gesichert …",
  "meetingRecord.notes.processing": "Notizen werden geschrieben …",
  "meetingRecord.notes.done": "Die Notizen sind auf Home bereit.",
  "meetingRecord.notes.needs_permission":
    "Die Notizen warten auf dein Okay, ein Cloud-Modell zu nutzen.",
  "meetingRecord.notes.failed": "Psyche konnte aus dieser Aufnahme keine Notizen schreiben.",
  "automationChat.label": "Läufe von {title}",
  "automationChat.runs": "{n, plural, one {# Lauf} other {# Läufe}}",
  "automationChat.runs.aria":
    "{title}, {n, plural, one {# Lauf} other {# Läufe}}, letzter Lauf {status}",
  "automationChat.schedule": "Geplant",
  "automationChat.runNow": "Jetzt ausführen",
  "automationChat.empty":
    "Noch keine Läufe. Jedes Mal, wenn diese Automatisierung läuft, erscheint sie hier.",
  "automationChat.loading": "Die Läufe werden geladen",
  "automationChat.failed": "Psyche konnte die Läufe nicht laden",
  "automationChat.more": "Ältere Läufe anzeigen",
  "automationChat.status.needsYou": "Braucht dich",
  "automationChat.status.running": "Läuft",
  "automationChat.trigger.manual": "Jetzt ausführen",
  "automationChat.trigger.event": "Bei einem Ereignis",
  "automationChat.coalesced": "{n} verpasste Läufe in einem",
  "automationChat.noResult": "Kein Ergebnis geschrieben",
  "automationChat.noSteps": "Für diesen Lauf wurden keine Schritte aufgezeichnet.",
  "automationChat.stepsLoading": "Die Schritte werden geladen",
  "automationChat.timeline": "Im Verlauf öffnen",
  "automationChat.approvals": "Genehmigungen öffnen",
  "automationChat.waiting": "Dieser Lauf wartet auf dich.",
  "automationChat.result": "Ergebnis",
  "automationChat.openScheduled": "Unter „Geplant“ öffnen",
  "automationChat.row.runs": "{n, plural, one {# Lauf} other {# Läufe}}",
  "automationChat.row.last": "Letzter Lauf: {status}",
};
