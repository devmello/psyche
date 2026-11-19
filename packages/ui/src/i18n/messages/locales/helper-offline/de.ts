import type { Catalogue } from "../../index.ts";

/** The helper-offline banner in the desktop app (de); merged into `../de.ts`. */
export const helperOffline: Partial<Catalogue> = {
  "platform.helper.offline.title": "Psyche Helper ist nicht verbunden",
  "platform.helper.offline.text":
    "Mail, Notizen, Kalender, Erinnerungen und die Arbeit, die davon abhängt, warten, bis er wieder verbunden ist.",
  "platform.helper.offline.reconnect": "Neu verbinden",
  "platform.helper.contactsPermission":
    "Kontakte brauchen die Berechtigung für den Psyche Helper in den Systemeinstellungen.",
  "platform.helper.offline.dismiss": "Schließen",
  "platform.helper.choose.title": "Zwei Psyche Helper sind verbunden",
  "platform.helper.choose.text":
    "Psyche rät nicht, welcher auf diesem Computer läuft. Mail, Notizen, Kalender und Erinnerungen pausieren deshalb. Wähle den Helper, der verwendet werden soll.",
  "platform.helper.choose.use": "{name} verwenden",
  "platform.helper.choose.failed": "Der Helper konnte nicht gewählt werden: {reason}",
};
