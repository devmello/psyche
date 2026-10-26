import type { Catalogue } from "../../index.ts";

/** Link menu and setting strings (ar); merged into `../ar.ts`. */
export const links: Partial<Catalogue> = {
  "links.menu.label": "فتح الرابط",
  "links.menu.goesTo": "يؤدي هذا الرابط إلى",
  "links.menu.punycode": "يستخدم العنوان أحرفًا متشابهة المظهر؛ تحقق منه بعناية.",
  "links.menu.openInPsyche": "فتح في Psyche",
  "links.menu.openInBrowser": "فتح في المتصفح",
  "links.menu.copy": "نسخ الرابط",
  "settings.key.ui.links.openIn": "فتح الروابط في",
  "settings.links.title": "الروابط",
  "settings.links.description":
    "المكان الذي يُفتح فيه رابط في رسالة أو بطاقة أو عنصر. النقر مع ⌘ يستخدم دائمًا المتصفح الافتراضي.",
  "settings.links.openIn.ask": "اسأل في كل مرة",
  "settings.links.openIn.psyche": "متصفح Psyche",
  "settings.links.openIn.browser": "المتصفح الافتراضي",
};
