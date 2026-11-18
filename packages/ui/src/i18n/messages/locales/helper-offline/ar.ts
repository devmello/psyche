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
};
