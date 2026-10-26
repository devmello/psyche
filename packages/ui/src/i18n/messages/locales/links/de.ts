import type { Catalogue } from "../../index.ts";

/** Link menu and setting strings (de); merged into `../de.ts`. */
export const links: Partial<Catalogue> = {
  "links.menu.label": "Link öffnen",
  "links.menu.goesTo": "Dieser Link führt zu",
  "links.menu.punycode": "Die Adresse enthält ähnlich aussehende Zeichen; prüfe sie sorgfältig.",
  "links.menu.openInPsyche": "In Psyche öffnen",
  "links.menu.openInBrowser": "Im Browser öffnen",
  "links.menu.copy": "Link kopieren",
  "settings.key.ui.links.openIn": "Links öffnen in",
  "settings.links.title": "Links",
  "settings.links.description":
    "Wo ein Link in einer Chatnachricht, Karte oder einem Artefakt geöffnet wird. ⌘-Klick nutzt immer deinen Standardbrowser.",
  "settings.links.openIn.ask": "Jedes Mal fragen",
  "settings.links.openIn.psyche": "Psyche-Browser",
  "settings.links.openIn.browser": "Standardbrowser",
};
