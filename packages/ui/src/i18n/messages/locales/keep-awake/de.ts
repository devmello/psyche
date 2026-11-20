import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (de); merged into `../de.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "Diesen Computer wach halten",
  "settings.daily.keepAwake.hint":
    "Solange ein geplanter Lauf läuft, geht dieser Computer nicht in den Ruhezustand. Der Bildschirm darf trotzdem ausgehen.",
  "settings.key.scheduled.keepAwake":
    "Diesen Computer wach halten, während geplante Aufgaben laufen",
  "scheduled.history.retryingAt": "Neuer Versuch um {time}",
  "scheduled.history.retry": "Wiederholung {n} von 3",
  "scheduled.history.failedAfterRetries": "Nach {n} Wiederholungen fehlgeschlagen",
  "scheduled.history.cancelRetry": "Wiederholung abbrechen",
  "scheduled.history.cancelRetry.aria": "Die Wiederholung des Laufs von {when} abbrechen",
  "scheduled.history.cancelRetry.failed":
    "Die Wiederholung konnte nicht abgebrochen werden ({reason}).",
  "settings.updates.group": "Updates",
  "settings.updates.hint": "Psyche sucht nach signierten Updates und installiert sie beim Beenden.",
  "settings.updates.channel": "Release-Kanal",
  "settings.updates.channel.stable": "Stabil",
  "settings.updates.channel.note":
    "Stabil ist vorerst der einzige Kanal. Beta erscheint hier, sobald Beta-Builds veröffentlicht werden. Jedes Update wird in jedem Fall mit dem Release-Schlüssel von Psyche geprüft.",
  "settings.storage.title": "Speicher",
  "settings.storage.hint":
    "Speicherplatz, den Psyche in seinem Datenordner auf diesem Computer belegt.",
  "settings.storage.total": "Gesamt",
  "settings.storage.clear": "Leeren…",
  "settings.storage.cleared": "Geleert. {size} freigegeben.",
  "settings.storage.clearFailed": "Der Speicher konnte nicht geleert werden ({reason}).",
  "settings.storage.failed": "Die Speichernutzung konnte nicht gelesen werden ({reason}).",
  "settings.storage.confirm.title": "Caches und alte Aufnahmen leeren?",
  "settings.storage.confirm.body":
    "Dadurch werden {size} an Caches und Browser-Aufnahmen gelöscht, die älter als 7 Tage sind, samt ihren Einträgen in der Bibliothek. Psyche baut Caches bei Bedarf neu auf. Deine Chats, dein Gedächtnis, andere Bibliotheksdateien, der Tresor und die Einstellungen bleiben unberührt.",
  "settings.storage.confirm.clear": "Leeren",
  "settings.storage.cat.database": "Datenbank",
  "settings.storage.cat.memoryIndex": "Gedächtnis-Index",
  "settings.storage.cat.library": "Anhänge und Bibliothek",
  "settings.storage.cat.browserProfiles": "Browserprofile",
  "settings.storage.cat.recordings": "Aufnahmen",
  "settings.storage.cat.logs": "Protokolle",
  "settings.storage.cat.caches": "Caches",
  "settings.storage.cat.other": "Alles andere",
};
