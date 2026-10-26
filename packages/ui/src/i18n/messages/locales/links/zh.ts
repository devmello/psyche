import type { Catalogue } from "../../index.ts";

/** Link menu and setting strings (zh); merged into `../zh.ts`. */
export const links: Partial<Catalogue> = {
  "links.menu.label": "打开链接",
  "links.menu.goesTo": "此链接指向",
  "links.menu.punycode": "该地址使用了外观相似的字符，请仔细核对。",
  "links.menu.openInPsyche": "在 Psyche 中打开",
  "links.menu.openInBrowser": "在浏览器中打开",
  "links.menu.copy": "复制链接",
  "settings.key.ui.links.openIn": "链接打开方式",
  "settings.links.title": "链接",
  "settings.links.description":
    "聊天消息、卡片或制品中的链接在哪里打开。按住 ⌘ 点击始终使用默认浏览器。",
  "settings.links.openIn.ask": "每次询问",
  "settings.links.openIn.psyche": "Psyche 浏览器",
  "settings.links.openIn.browser": "默认浏览器",
};
