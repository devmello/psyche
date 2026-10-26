import type { Catalogue } from "../../index.ts";

/** Link menu and setting strings (es); merged into `../es.ts`. */
export const links: Partial<Catalogue> = {
  "links.menu.label": "Abrir enlace",
  "links.menu.goesTo": "Este enlace va a",
  "links.menu.punycode":
    "La dirección usa caracteres que se parecen a otros; revísala con cuidado.",
  "links.menu.openInPsyche": "Abrir en Psyche",
  "links.menu.openInBrowser": "Abrir en el navegador",
  "links.menu.copy": "Copiar enlace",
  "settings.key.ui.links.openIn": "Abrir enlaces en",
  "settings.links.title": "Enlaces",
  "settings.links.description":
    "Dónde se abre un enlace de un mensaje, tarjeta o artefacto. ⌘-clic siempre usa tu navegador predeterminado.",
  "settings.links.openIn.ask": "Preguntar cada vez",
  "settings.links.openIn.psyche": "Navegador de Psyche",
  "settings.links.openIn.browser": "Navegador predeterminado",
};
