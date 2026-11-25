import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (ar); merged into `../ar.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "إبقاء هذا الجهاز مستيقظًا",
  "settings.daily.keepAwake.hint":
    "أثناء تشغيل مهمة مجدولة، لن ينام هذا الجهاز حتى تنتهي. يمكن أن تنطفئ الشاشة.",
  "settings.key.scheduled.keepAwake": "إبقاء هذا الجهاز مستيقظًا أثناء تشغيل المهام المجدولة",
  "scheduled.history.retryingAt": "إعادة المحاولة عند {time}",
  "scheduled.history.retry": "المحاولة {n} من 3",
  "scheduled.history.failedAfterRetries": "فشل بعد {n} من إعادات المحاولة",
  "scheduled.history.cancelRetry": "إلغاء إعادة المحاولة",
  "scheduled.history.cancelRetry.aria": "إلغاء إعادة محاولة التشغيل من {when}",
  "scheduled.history.cancelRetry.failed": "تعذّر إلغاء إعادة المحاولة ({reason}).",
  "settings.updates.group": "التحديثات",
  "settings.updates.hint": "يبحث Psyche عن تحديثات موقّعة ويثبّتها عند الإنهاء.",
  "settings.updates.channel": "قناة الإصدارات",
  "settings.updates.channel.stable": "مستقرة",
  "settings.updates.channel.note":
    "القناة المستقرة هي الوحيدة حاليًا. ستظهر القناة التجريبية هنا عند نشر إصدارات تجريبية. يُتحقَّق من كل تحديث بمفتاح إصدار Psyche في كل الأحوال.",
  "settings.storage.title": "التخزين",
  "settings.storage.hint": "مساحة القرص التي يستخدمها Psyche في مجلد بياناته على هذا الكمبيوتر.",
  "settings.storage.total": "الإجمالي",
  "settings.storage.clear": "مسح…",
  "settings.storage.cleared": "تم المسح. تم تحرير {size}.",
  "settings.storage.clearFailed": "تعذّر مسح التخزين ({reason}).",
  "settings.storage.compact.title": "ضغط قاعدة البيانات",
  "settings.storage.compact.hint":
    "حجم قاعدة البيانات {size}، ويمكن استرجاع ما يصل إلى {reclaimable}. يتوقف Psyche لحظة أثناء التنفيذ.",
  "settings.storage.compact.button": "ضغط",
  "settings.storage.compact.running": "جارٍ الضغط…",
  "settings.storage.compact.done": "اكتمل الضغط في {seconds} ث، وتم توفير {size}.",
  "settings.storage.compact.failed": "تعذّر ضغط قاعدة البيانات ({reason}).",
  "settings.storage.compact.busy": "Psyche مشغول بمهمة. حاول مجددًا بعد انتهائها.",
  "settings.storage.failed": "تعذّرت قراءة استخدام التخزين ({reason}).",
  "settings.storage.confirm.title": "هل تريد مسح ذاكرات التخزين المؤقت والتسجيلات القديمة؟",
  "settings.storage.confirm.body":
    "سيؤدي هذا إلى حذف {size} من ذاكرات التخزين المؤقت وتسجيلات المتصفح الأقدم من 7 أيام، مع عناصرها في المكتبة. يعيد Psyche بناء ذاكرات التخزين المؤقت عند الحاجة. لا تتأثر محادثاتك وذاكرتك وملفات المكتبة الأخرى والخزنة والإعدادات.",
  "settings.storage.confirm.clear": "مسح",
  "settings.storage.cat.database": "قاعدة البيانات",
  "settings.storage.cat.memoryIndex": "فهرس الذاكرة",
  "settings.storage.cat.library": "المرفقات والمكتبة",
  "settings.storage.cat.browserProfiles": "ملفات تعريف المتصفح",
  "settings.storage.cat.recordings": "التسجيلات",
  "settings.storage.cat.logs": "السجلات",
  "settings.storage.cat.caches": "ذاكرات التخزين المؤقت",
  "settings.storage.cat.other": "كل ما عدا ذلك",
};
