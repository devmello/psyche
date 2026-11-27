import type { Catalogue } from "../../index.ts";

/** Simplify batch B4: devices and pairing (ar); merged into `../ar.ts`. */
export const simplifyB4: Partial<Catalogue> = {
  "simplify.b4.devices.title": "الأجهزة",
  "simplify.b4.devices.description": "أجهزة الكمبيوتر وأجهزة iPhone التي يمكنها استخدام Psyche.",
  "simplify.b4.devices.details": "التفاصيل",
  "simplify.b4.devices.canDo": "ما الذي يمكنه فعله",
  "simplify.b4.devices.canDoOf": "ما الذي يمكن لـ {name} فعله",
  "simplify.b4.devices.hostKey": "مفتاح هذا الكمبيوتر: {fingerprint}",
  "simplify.b4.devices.helpers": "المساعدات",
  "simplify.b4.devices.helpersHint": "تطبيقات صغيرة تتيح لـ Psyche العمل على الكمبيوتر.",
  "simplify.b4.devices.noHelpers":
    "لا توجد مساعدات بعد. يظهر المساعد هنا عند تشغيل Psyche على الكمبيوتر.",
  "simplify.b4.server.title": "الشبكة والوصول عن بُعد",
  "simplify.b4.server.description":
    "كيف تصل الأجهزة الأخرى إلى هذا الكمبيوتر، وكيف تستخدم Psyche خارج المنزل.",
  "simplify.b4.server.away": "استخدمه خارج المنزل",
  "simplify.b4.pairIphone.title": "اقتران iPhone",
  "simplify.b4.pairIphone.description":
    "امسح رمزًا بواسطة Psyche على جهاز iPhone. يجب أن يكون iPhone وهذا الكمبيوتر على شبكة Wi-Fi نفسها.",
  "simplify.b4.pairIphone.button": "اقتران iPhone",
  "simplify.b4.pairIphone.scan": "افتح Psyche على جهاز iPhone وامسح هذا الرمز. يعمل مرة واحدة فقط.",
  "simplify.b4.pairIphone.lanOn":
    "شغّل الاقتران الوصول عبر الشبكة، ليتمكن iPhone من العثور على هذا الكمبيوتر.",
  "simplify.b4.pairIphone.lanOff": "تم إيقاف الوصول عبر الشبكة مرة أخرى.",
  "simplify.b4.pairIphone.turnOff": "إيقاف الوصول عبر الشبكة",
  "simplify.b4.pairIphone.enableFailed": "تعذّر تشغيل الوصول عبر الشبكة: {reason}",
  "simplify.b4.pairIphone.turnOffFailed": "تعذّر إيقاف الوصول عبر الشبكة: {reason}",
  "simplify.b4.pairIphone.noNetwork":
    "لا يمكن الوصول إلى هذا الكمبيوتر عبر شبكتك الآن. تأكد من تشغيل Wi-Fi ثم حاول مرة أخرى.",
};
