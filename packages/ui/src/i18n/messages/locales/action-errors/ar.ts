import type { Catalogue } from "../../index.ts";

/** Failure messages for user actions (ar); merged into `../ar.ts`. */
export const actionErrors: Partial<Catalogue> = {
  "actionError.exportPerson": "تعذّر تصدير بيانات هذا الشخص ({reason}).",
  "actionError.revokeGrant": "تعذّر إلغاء هذه الموافقة ({reason}). ما زالت سارية.",
  "actionError.reindex": "تعذّر إعادة بناء فهرس البحث ({reason}).",
  "actionError.rerun": "تعذّر إعادة تشغيل هذه الأتمتة ({reason}).",
  "actionError.stopResearch": "تعذّر إيقاف البحث ({reason}). ما زال يعمل.",
  "actionError.unmute": "تعذّر إعادة تفعيل التذكيرات ({reason}).",
  "actionError.language": "تعذّر تغيير اللغة ({reason}).",
  "actionError.transcriptMode": "تعذّر تغيير تفاصيل النص ({reason}).",
  "actionError.screenAskDestination": "تعذّر تغيير وجهة أسئلة الشاشة ({reason}).",
  "actionError.stopVirtualScreen": "تعذّر إيقاف الشاشة الافتراضية ({reason}). قد تكون ما زالت تعمل.",
  "actionError.takeOver": "تعذّر تولّي الشاشة الافتراضية ({reason}).",
};
