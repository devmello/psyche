import type { Catalogue } from "../../index.ts";

/** Link menu and setting strings (it); merged into `../it.ts`. */
export const links: Partial<Catalogue> = {
  "links.menu.label": "Apri link",
  "links.menu.goesTo": "Questo link porta a",
  "links.menu.punycode":
    "L'indirizzo usa caratteri che sembrano altri; controllalo con attenzione.",
  "links.menu.openInPsyche": "Apri in Psyche",
  "links.menu.openInBrowser": "Apri nel browser",
  "links.menu.copy": "Copia link",
  "settings.key.ui.links.openIn": "Apri i link in",
  "settings.links.title": "Link",
  "settings.links.description":
    "Dove si apre un link in un messaggio, una scheda o un artefatto. ⌘-clic usa sempre il browser predefinito.",
  "settings.links.openIn.ask": "Chiedi ogni volta",
  "settings.links.openIn.psyche": "Browser di Psyche",
  "settings.links.openIn.browser": "Browser predefinito",
};
