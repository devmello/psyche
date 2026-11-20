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
};
