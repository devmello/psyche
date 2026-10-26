import type { Catalogue } from "../../index.ts";

/** Output canvas strings (ar); merged into `../ar.ts`. */
export const canvas: Partial<Catalogue> = {
  "canvas.chart": "مخطط",
  "canvas.htmlOff":
    "هذا من محتوى غير موثوق، لذا المعاينة متوقفة. شغّله فقط إذا كنت تثق به. يعمل في بيئة معزولة بلا شبكة.",
  "canvas.htmlRun": "تشغيل",
  "canvas.htmlNoPreview": "لا يستطيع هذا المضيف معاينة HTML؛ يُعرض المصدر.",
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
  "canvas.map": "خريطة",
  "map.label": "خريطة: {title}",
  "map.untitled": "خريطة",
  "map.list": "الأماكن",
  "map.openLink": "فتح الرابط",
  "map.empty": "لا توجد أماكن للعرض.",
  "map.tilesOff": "بلاطات الخريطة متوقفة في الإعدادات. تُعرض القائمة.",
  "map.tilesFailed": "تعذّر تحميل الخريطة. تُعرض القائمة.",
  "map.showMap": "عرض الخريطة",
  "map.showList": "عرض القائمة",
  "map.card": "خريطة: {title}",
  "map.meta": "{count, plural, one {# مكان} other {# أماكن}} · {date}",
  "map.openCanvas": "فتح في اللوحة",
  "map.invalid": "تعذّرت قراءة هذه الخريطة.",
  "map.gesture.windows": "استخدم Ctrl مع التمرير لتكبير الخريطة",
  "map.gesture.mac": "استخدم ⌘ مع التمرير لتكبير الخريطة",
  "map.gesture.mobile": "استخدم إصبعين لتحريك الخريطة",
  "settings.map.title": "الخرائط",
  "settings.map.privacy":
    "عرض الخريطة يطلب من خادم البلاط المنطقة التي تنظر إليها، لذا يستطيع الخادم معرفة المكان الذي تنظر إليه تقريبًا. أوقف البلاط لعرض الأماكن كقائمة فقط، أو استخدم خادم بلاط خاصًا بك.",
  "settings.map.tiles": "عرض بلاطات الخريطة",
  "settings.map.tilesHint": "الإيقاف يعرض الأماكن كقائمة دون أي طلبات خريطة.",
  "settings.map.style": "رابط نمط خادم البلاط",
  "settings.map.styleHint":
    "رابط JSON لنمط MapLibre، مثل خادمك الخاص. تركه فارغًا يستخدم بلاطات OpenFreeMap المجانية (https فقط؛ http لـ localhost).",
  "settings.map.styleDark": "رابط النمط (داكن)",
  "settings.map.styleDarkHint":
    "اختياري. تركه فارغًا يستخدم النمط أعلاه أيضًا في الوضع الداكن، أو نمط OpenFreeMap الداكن.",
};
