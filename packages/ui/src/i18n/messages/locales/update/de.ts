import type { Catalogue } from "../../index.ts";

/** App update strings (de); merged into `../de.ts`. */
export const update: Partial<Catalogue> = {
  "shell.update.ready": "Psyche {version} ist bereit",
  "shell.update.readyRequired": "Psyche {version} ist bereit. Dieses Update ist erforderlich.",
  "shell.update.restart": "Zum Aktualisieren neu starten",
  "shell.update.dismiss": "Update-Hinweis ausblenden",
  "settings.updates.status": "Status",
  "settings.updates.checking": "Suche nach Updates…",
  "settings.updates.upToDate": "Auf dem neuesten Stand",
  "settings.updates.ready": "Psyche {version} ist bereit",
  "settings.updates.readyRequired": "Psyche {version} ist bereit (erforderlich)",
  "settings.updates.refused": "Update abgelehnt: {reason}",
};
