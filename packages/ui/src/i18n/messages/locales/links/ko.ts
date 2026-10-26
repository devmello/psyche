import type { Catalogue } from "../../index.ts";

/** Link menu and setting strings (ko); merged into `../ko.ts`. */
export const links: Partial<Catalogue> = {
  "links.menu.label": "링크 열기",
  "links.menu.goesTo": "이 링크의 이동 위치",
  "links.menu.punycode": "주소에 비슷하게 생긴 문자가 쓰였습니다. 주의해서 확인하세요.",
  "links.menu.openInPsyche": "Psyche에서 열기",
  "links.menu.openInBrowser": "브라우저에서 열기",
  "links.menu.copy": "링크 복사",
  "settings.key.ui.links.openIn": "링크 열기 위치",
  "settings.links.title": "링크",
  "settings.links.description":
    "채팅 메시지, 카드, 아티팩트의 링크가 열리는 곳입니다. ⌘-클릭은 항상 기본 브라우저로 엽니다.",
  "settings.links.openIn.ask": "매번 묻기",
  "settings.links.openIn.psyche": "Psyche 브라우저",
  "settings.links.openIn.browser": "기본 브라우저",
};
