import type { Catalogue } from "../../index.ts";

/** App update strings (ar); merged into `../ar.ts`. */
export const update: Partial<Catalogue> = {
  "shell.update.ready": "Psyche {version} جاهز",
  "shell.update.readyRequired": "Psyche {version} جاهز. هذا التحديث مطلوب.",
  "shell.update.restart": "أعد التشغيل للتحديث",
  "shell.update.dismiss": "إخفاء إشعار التحديث",
  "settings.updates.status": "الحالة",
  "settings.updates.checking": "جارٍ التحقق من التحديثات…",
  "settings.updates.upToDate": "محدَّث",
  "settings.updates.ready": "Psyche {version} جاهز",
  "settings.updates.readyRequired": "Psyche {version} جاهز (مطلوب)",
  "settings.updates.refused": "تم رفض التحديث: {reason}",
};
