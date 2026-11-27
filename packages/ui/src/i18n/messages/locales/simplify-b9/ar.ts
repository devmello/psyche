import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (ar); merged into `../ar.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplify.b9.approval.expiresAt": "تنتهي الصلاحية عند {time}",
  "simplify.b9.execHost.sandboxed": "يعمل داخل الصندوق الرملي.",
  "simplify.b9.execHost.noSandbox":
    "الصندوق الرملي غير مُعدّ، لذلك لا يمكن تشغيل هذا الأمر إلا بدونه. أعدّه أو شغّل الأمر مرة واحدة بدون الصندوق الرملي.",
  "simplify.b9.execHost.noHostSandbox":
    "لا يوجد صندوق رملي للأوامر على هذا الكمبيوتر، لذلك لا يمكن تشغيل هذا الأمر إلا بدونه. يمكنك تشغيله هذه المرة فقط.",
  "simplify.b9.execHost.runOnce": "تشغيل مرة واحدة بدون الصندوق الرملي",
  "simplify.b9.library.madeBy": "من إنشاء {name}",
  "simplify.b9.library.task": "المهمة",
  "simplify.b9.library.more": "مزيد من عوامل التصفية",
};
