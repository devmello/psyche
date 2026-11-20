import type { Catalogue } from "../../index.ts";

/** Linux access in Settings → Computer use (ar); merged into `../ar.ts`. */
export const linuxAccess: Partial<Catalogue> = {
  "settings.computerUse.linux.screen.name": "الوصول إلى الشاشة والإدخال",
  "settings.computerUse.linux.screen.allowed": "مسموح به حتى تلغيه",
  "settings.computerUse.linux.screen.asks": "يسأل عند أول استخدام",
  "settings.computerUse.linux.screen.notNeeded": "غير مطلوب على X11",
  "settings.computerUse.linux.screen.unavailable": "غير متاح",
  "settings.computerUse.linux.screen.why":
    "يرى {persona} شاشتك ويستخدم الماوس ولوحة المفاتيح عبر مربع حوار الأذونات في سطح المكتب. توافق مرة واحدة فقط.",
  "settings.computerUse.linux.revoke": "إلغاء الإذن",
  "settings.computerUse.linux.revokeLabel": "إلغاء الوصول إلى الشاشة والإدخال",
  "settings.computerUse.linux.warning.x11":
    "على X11 يمكن لأي تطبيق قراءة شاشتك وضغطات مفاتيحك، بما في ذلك كلمة المرور عندما توافق على شيء.",
  "settings.computerUse.linux.warning.wlroots":
    "على سطح المكتب هذا يمكن لأي تطبيق قراءة شاشتك والكتابة نيابةً عنك دون أن يسأل. لا يستطيع Psyche إضافة خطوة موافقة.",
  "settings.computerUse.linux.accessibility":
    "التطبيقات التي تُفتح من الآن فصاعدًا تكشف بنيتها لـ Psyche. قد تحتاج التطبيقات المفتوحة بالفعل إلى إعادة تشغيل.",
  "settings.computerUse.linux.headless":
    "يحتاج إلى جلسة رسومية على هذا الكمبيوتر. سجّل الدخول إلى سطح المكتب ثم حاول مرة أخرى.",
};
