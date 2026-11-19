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
  "platform.helper.choose.title": "Mehr als ein Psyche Helper ist verbunden",
  "platform.helper.choose.text":
    "Psyche wählt nicht für dich, deshalb pausieren Mail, Notizen, Kalender und Erinnerungen. Wähle, welcher verwendet wird, solange alle verbunden sind.",
  "platform.helper.choose.use": "Den Helper verwenden, der am {when} gekoppelt wurde (…{id})",
  "platform.helper.choose.useNoTime": "Den Helper verwenden (…{id})",
  "platform.helper.choose.name": "Nennt sich selbst: {name}",
  "platform.helper.choose.failed": "Der Helper konnte nicht gewählt werden: {reason}",
};
