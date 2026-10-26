import type { Catalogue } from "../../index.ts";

/** Link menu and setting strings (fr); merged into `../fr.ts`. */
export const links: Partial<Catalogue> = {
  "links.menu.label": "Ouvrir le lien",
  "links.menu.goesTo": "Ce lien mène à",
  "links.menu.punycode": "L'adresse utilise des caractères trompeurs ; vérifiez-la avec soin.",
  "links.menu.openInPsyche": "Ouvrir dans Psyche",
  "links.menu.openInBrowser": "Ouvrir dans le navigateur",
  "links.menu.copy": "Copier le lien",
  "settings.key.ui.links.openIn": "Ouvrir les liens dans",
  "settings.links.title": "Liens",
  "settings.links.description":
    "Où s'ouvre un lien d'un message, d'une carte ou d'un artefact. ⌘-clic utilise toujours votre navigateur par défaut.",
  "settings.links.openIn.ask": "Demander à chaque fois",
  "settings.links.openIn.psyche": "Navigateur Psyche",
  "settings.links.openIn.browser": "Navigateur par défaut",
};
