import type { Catalogue } from "../../index.ts";

/** Output canvas strings (de); merged into `../de.ts`. */
export const canvas: Partial<Catalogue> = {
  "canvas.chart": "Diagramm",
  "canvas.label": "Canvas: {title}",
  "canvas.recents": "Letzte Ergebnisse",
  "canvas.loading": "Wird geladen …",
  "canvas.missing": "Psyche konnte dieses Ergebnis nicht laden.",
  "canvas.untrusted": "Aus nicht vertrauenswürdigen Inhalten",
  "canvas.version": "Version",
  "canvas.versionOption":
    "v{version} · {author, select, user {du} specialist {Spezialist} other {Psyche}} · {time}",
  "canvas.copy": "Kopieren",
  "canvas.copied": "Kopiert",
  "canvas.download": "Herunterladen",
  "canvas.restore": "Als neue Version wiederherstellen",
  "canvas.oldVersion": "Version {version} (schreibgeschützt).",
  "canvas.conflict":
    "Das hat sich während deiner Bearbeitung geändert, deshalb wurde deine Änderung nicht gesichert. Versuche es mit der neuesten Version erneut.",
  "canvas.saveFailed": "Sichern fehlgeschlagen: {message}",
};
