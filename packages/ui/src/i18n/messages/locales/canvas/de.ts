import type { Catalogue } from "../../index.ts";

/** Output canvas strings (de); merged into `../de.ts`. */
export const canvas: Partial<Catalogue> = {
  "canvas.chart": "Diagramm",
  "canvas.htmlOff":
    "Das stammt aus nicht vertrauenswürdigen Inhalten, deshalb ist die Vorschau aus. Führe sie nur aus, wenn du ihr vertraust. Sie läuft in einer Sandbox ohne Netzwerk.",
  "canvas.htmlRun": "Ausführen",
  "canvas.htmlNoPreview": "Dieser Host kann kein HTML anzeigen; der Quelltext wird gezeigt.",
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
  "canvas.map": "Karte",
  "map.label": "Karte: {title}",
  "map.untitled": "Karte",
  "map.list": "Orte",
  "map.openLink": "Link öffnen",
  "map.empty": "Keine Orte zum Anzeigen.",
  "map.tilesOff": "Kartenkacheln sind in den Einstellungen aus. Die Liste wird gezeigt.",
  "map.tilesFailed": "Die Karte konnte nicht geladen werden. Die Liste wird gezeigt.",
  "map.showMap": "Karte zeigen",
  "map.showList": "Liste zeigen",
  "map.card": "Karte: {title}",
  "map.meta": "{count, plural, one {# Ort} other {# Orte}} · {date}",
  "map.openCanvas": "Im Canvas öffnen",
  "map.invalid": "Diese Karte konnte nicht gelesen werden.",
  "map.gesture.windows": "Strg + Scrollen zum Zoomen der Karte",
  "map.gesture.mac": "⌘ + Scrollen zum Zoomen der Karte",
  "map.gesture.mobile": "Mit zwei Fingern die Karte bewegen",
  "settings.map.title": "Karten",
  "settings.map.privacy":
    "Eine Karte fragt bei einem Kachelserver den angezeigten Bereich an; dieser Server erfährt so ungefähr, wohin du schaust. Schalte Kacheln aus, um Orte nur als Liste zu sehen, oder nutze einen eigenen Kachelserver. Anfragen laufen über dein Gateway; der Kachelserver sieht das Gateway, nicht dein Gerät.",
  "settings.map.tiles": "Kartenkacheln anzeigen",
  "settings.map.tilesHint": "Aus zeigt Orte als Liste ohne Kartenanfragen.",
  "settings.map.style": "Stil-URL des Kachelservers",
  "settings.map.styleHint":
    "Eine MapLibre-Stil-JSON-URL, z. B. von deinem eigenen Server. Leer nutzt die kostenlosen OpenFreeMap-Kacheln (nur https; http für localhost).",
  "settings.map.styleDark": "Stil-URL (dunkel)",
  "settings.map.styleDarkHint":
    "Optional. Leer nutzt den obigen Stil auch im Dunkelmodus oder den dunklen OpenFreeMap-Stil.",
};
