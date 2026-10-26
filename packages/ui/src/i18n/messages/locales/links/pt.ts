import type { Catalogue } from "../../index.ts";

/** Link menu and setting strings (pt); merged into `../pt.ts`. */
export const links: Partial<Catalogue> = {
  "links.menu.label": "Abrir link",
  "links.menu.goesTo": "Este link vai para",
  "links.menu.punycode": "O endereço usa caracteres parecidos com outros; confira com cuidado.",
  "links.menu.openInPsyche": "Abrir no Psyche",
  "links.menu.openInBrowser": "Abrir no navegador",
  "links.menu.copy": "Copiar link",
  "settings.key.ui.links.openIn": "Abrir links em",
  "settings.links.title": "Links",
  "settings.links.description":
    "Onde abre um link de uma mensagem, cartão ou artefato. ⌘-clique sempre usa o navegador padrão.",
  "settings.links.openIn.ask": "Perguntar sempre",
  "settings.links.openIn.psyche": "Navegador do Psyche",
  "settings.links.openIn.browser": "Navegador padrão",
};
