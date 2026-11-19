import type { Catalogue } from "../../index.ts";

/** The helper-offline banner in the desktop app (ar); merged into `../ar.ts`. */
export const helperOffline: Partial<Catalogue> = {
  "platform.helper.offline.title": "مساعد Psyche غير متصل",
  "platform.helper.offline.text":
    "تنتظر الرسائل والملاحظات والتقويم والتذكيرات والأعمال المرتبطة بها حتى يعاد الاتصال.",
  "platform.helper.offline.reconnect": "إعادة الاتصال",
  "platform.helper.contactsPermission":
    "تحتاج جهات الاتصال إلى إذن لمساعد Psyche في إعدادات النظام.",
  "platform.helper.offline.dismiss": "تجاهل",
  "platform.helper.choose.title": "هناك أكثر من Psyche Helper متصل",
  "platform.helper.choose.text":
    "لن يختار Psyche واحدًا نيابةً عنك، لذا توقفت البريد والملاحظات والتقويم والتذكيرات مؤقتًا. اختر أيها يُستخدم ما دامت كلها متصلة.",
  "platform.helper.choose.use": "استخدام المساعد الذي اقترن في {when} (…{id})",
  "platform.helper.choose.useNoTime": "استخدام المساعد (…{id})",
  "platform.helper.choose.name": "يسمّي نفسه: {name}",
  "platform.helper.choose.failed": "تعذّر اختيار المساعد: {reason}",
};
