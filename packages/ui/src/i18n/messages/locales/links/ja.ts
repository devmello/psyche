import type { Catalogue } from "../../index.ts";

/** Link menu and setting strings (ja); merged into `../ja.ts`. */
export const links: Partial<Catalogue> = {
  "links.menu.label": "リンクを開く",
  "links.menu.goesTo": "このリンクの移動先",
  "links.menu.punycode": "アドレスに紛らわしい文字が使われています。よく確認してください。",
  "links.menu.openInPsyche": "Psycheで開く",
  "links.menu.openInBrowser": "ブラウザで開く",
  "links.menu.copy": "リンクをコピー",
  "settings.key.ui.links.openIn": "リンクを開く場所",
  "settings.links.title": "リンク",
  "settings.links.description":
    "チャットのメッセージ、カード、アーティファクト内のリンクを開く場所です。⌘クリックは常に既定のブラウザで開きます。",
  "settings.links.openIn.ask": "毎回確認",
  "settings.links.openIn.psyche": "Psycheブラウザ",
  "settings.links.openIn.browser": "既定のブラウザ",
};
