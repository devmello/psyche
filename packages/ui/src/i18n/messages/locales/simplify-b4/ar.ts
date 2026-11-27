import type { Catalogue } from "../../index.ts";

/** Simplify batch B4: devices and pairing (ar); merged into `../ar.ts`. */
export const simplifyB4: Partial<Catalogue> = {
  "simplifyB4.devices.title": "الأجهزة",
  "simplifyB4.devices.description": "أجهزة الكمبيوتر وأجهزة iPhone التي يمكنها استخدام Psyche.",
  "simplifyB4.devices.details": "التفاصيل",
  "simplifyB4.devices.canDo": "ما الذي يمكنه فعله",
  "simplifyB4.devices.canDoOf": "ما الذي يمكن لـ {name} فعله",
  "simplifyB4.devices.hostKey": "مفتاح هذا الكمبيوتر: {fingerprint}",
  "simplifyB4.devices.helpers": "المساعدات",
  "simplifyB4.devices.helpersHint": "تطبيقات صغيرة تتيح لـ Psyche العمل على الكمبيوتر.",
  "simplifyB4.devices.noHelpers": "لا توجد مساعدات بعد. يظهر المساعد هنا عند تشغيل Psyche على الكمبيوتر.",
  "simplifyB4.server.title": "الشبكة والوصول عن بُعد",
  "simplifyB4.server.description": "كيف تصل الأجهزة الأخرى إلى هذا الكمبيوتر، وكيف تستخدم Psyche خارج المنزل.",
  "simplifyB4.server.away": "استخدمه خارج المنزل",
  "simplifyB4.pairIphone.title": "اقتران iPhone",
  "simplifyB4.pairIphone.description": "امسح رمزًا بواسطة Psyche على جهاز iPhone. يجب أن يكون iPhone وهذا الكمبيوتر على شبكة Wi-Fi نفسها.",
  "simplifyB4.pairIphone.button": "اقتران iPhone",
  "simplifyB4.pairIphone.scan": "افتح Psyche على جهاز iPhone وامسح هذا الرمز. يعمل مرة واحدة فقط.",
  "simplifyB4.pairIphone.lanOn": "شغّل الاقتران الوصول عبر الشبكة، ليتمكن iPhone من العثور على هذا الكمبيوتر.",
  "simplifyB4.pairIphone.lanOff": "تم إيقاف الوصول عبر الشبكة مرة أخرى.",
  "simplifyB4.pairIphone.turnOff": "إيقاف الوصول عبر الشبكة",
  "simplifyB4.pairIphone.enableFailed": "تعذّر تشغيل الوصول عبر الشبكة: {reason}",
  "simplifyB4.pairIphone.turnOffFailed": "تعذّر إيقاف الوصول عبر الشبكة: {reason}",
  "simplifyB4.pairIphone.noNetwork": "لا يمكن الوصول إلى هذا الكمبيوتر عبر شبكتك الآن. تأكد من تشغيل Wi-Fi ثم حاول مرة أخرى.",
};
