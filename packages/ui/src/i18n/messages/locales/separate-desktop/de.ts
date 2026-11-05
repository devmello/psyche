import type { Catalogue } from "../../index.ts";

/** Settings > Computer use > Separate desktop (de); merged into `../de.ts`. */
export const separateDesktop: Partial<Catalogue> = {
  "settings.separateDesktop.title": "Separater Desktop",
  "settings.separateDesktop.description":
    "Ein privater Desktop in einem Container mit eigenen Apps und Dateien. Er sieht nur die Ordner, die du für eine Aufgabe freigibst, hat nur Internet, wenn du es für diese Aufgabe erlaubst, und endet mit der Aufgabe.",
  "settings.separateDesktop.state.off": "Läuft nicht",
  "settings.separateDesktop.state.starting": "Startet",
  "settings.separateDesktop.state.running": "Läuft",
  "settings.separateDesktop.state.stopping": "Wird beendet",
  "settings.separateDesktop.state.failed": "Konnte nicht starten",
  "settings.separateDesktop.engine": "Container-Engine: {engine}",
  "settings.separateDesktop.rootful":
    "Diese Container-Engine läuft als Root. Verwende rootless Podman für den separaten Desktop.",
  "settings.separateDesktop.memory": "Speicherlimit",
  "settings.separateDesktop.memoryHint":
    "Der meiste Speicher, den der separate Desktop während des Betriebs nutzen darf.",
  "settings.separateDesktop.memoryOption": "{gb} GB",
  "settings.separateDesktop.shares": "Freigegebene Ordner: {names}",
  "settings.separateDesktop.internet": "Internet ist für diese Aufgabe an",
  "settings.separateDesktop.reset": "Separaten Desktop zurücksetzen",
  "settings.separateDesktop.resetHint":
    "Löscht den Container und alles, was darin gespeichert ist. Ordner, die du freigegeben hast, bleiben unberührt.",
  "blocks.folder.sd.explain.ro":
    "{persona} möchte dem separaten Desktop erlauben, die Dateien in einem Ordner zu lesen.",
  "blocks.folder.sd.explain.rw":
    "{persona} möchte dem separaten Desktop erlauben, die Dateien in einem Ordner zu lesen und zu ändern. Programme im separaten Desktop können dort Dateien ändern, auch solche, die auf diesem Computer Programme ausführen, wie Git-Einstellungen und Skripte, und die Änderungen erscheinen auf diesem Computer.",
  "blocks.folder.sd.scope":
    "Der separate Desktop sieht diesen Ordner nur für diese Aufgabe. Sonst wird nichts auf diesem Computer geteilt, und kein anderes Werkzeug auf diesem Computer erhält den Ordner.",
  "blocks.folder.sd.scope.once": "Nur diese Aufgabe",
  "settings.separateDesktop.limitMemory":
    "Das Speicherlimit wird auf diesem System nicht durchgesetzt",
  "settings.separateDesktop.limitPids":
    "Das Prozesslimit wird auf diesem System nicht durchgesetzt",
  "blocks.details.sdUnverified":
    "Der separate Desktop kann nicht bestätigen, dass diese Seite wirklich {origin} ist. Fahre nur fort, wenn du dem Ziel der Aufgabe vertraust.",
  "blocks.details.sdFiles": "Dateien",
  "blocks.details.sdAlsoChanges":
    "Diese Aufgabe kann auch {folder} ändern und Dateien daraus senden.",
};
