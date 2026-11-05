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
};
