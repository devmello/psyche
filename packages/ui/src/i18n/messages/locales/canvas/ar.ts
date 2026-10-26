import type { Catalogue } from "../../index.ts";

/** Output canvas strings (ar); merged into `../ar.ts`. */
export const canvas: Partial<Catalogue> = {
  "canvas.chart": "مخطط",
  "canvas.label": "اللوحة: {title}",
  "canvas.recents": "المخرجات الأخيرة",
  "canvas.loading": "جارٍ التحميل…",
  "canvas.missing": "تعذّر على Psyche تحميل هذا الناتج.",
  "canvas.untrusted": "من محتوى غير موثوق",
  "canvas.version": "الإصدار",
  "canvas.versionOption":
    "v{version} · {author, select, user {أنت} specialist {مختص} other {Psyche}} · {time}",
  "canvas.copy": "نسخ",
  "canvas.copied": "تم النسخ",
  "canvas.download": "تنزيل",
  "canvas.restore": "استعادة كإصدار جديد",
  "canvas.oldVersion": "الإصدار {version} (للقراءة فقط).",
  "canvas.conflict": "تغيّر هذا أثناء تعديلك، لذا لم يُحفظ تعديلك. حاول مجددًا على أحدث إصدار.",
  "canvas.saveFailed": "تعذّر الحفظ: {message}",
};
