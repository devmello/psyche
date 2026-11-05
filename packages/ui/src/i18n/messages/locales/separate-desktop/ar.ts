import type { Catalogue } from "../../index.ts";

/** Settings > Computer use > Separate desktop (ar); merged into `../ar.ts`. */
export const separateDesktop: Partial<Catalogue> = {
  "settings.separateDesktop.title": "سطح مكتب منفصل",
  "settings.separateDesktop.description":
    "سطح مكتب خاص داخل حاوية، له تطبيقاته وملفاته الخاصة. لا يرى إلا المجلدات التي تشاركها لمهمة ما، ولا يملك إنترنت ما لم تسمح به لتلك المهمة، ويتوقف عند انتهاء المهمة.",
  "settings.separateDesktop.state.off": "غير قيد التشغيل",
  "settings.separateDesktop.state.starting": "جارٍ البدء",
  "settings.separateDesktop.state.running": "قيد التشغيل",
  "settings.separateDesktop.state.stopping": "جارٍ الإيقاف",
  "settings.separateDesktop.state.failed": "تعذّر البدء",
  "settings.separateDesktop.engine": "محرك الحاويات: {engine}",
  "settings.separateDesktop.rootful":
    "يعمل محرك الحاويات هذا بصلاحيات الجذر. استخدم Podman بدون جذر لسطح المكتب المنفصل.",
  "settings.separateDesktop.memory": "حد الذاكرة",
  "settings.separateDesktop.memoryHint":
    "أكبر قدر من الذاكرة يمكن لسطح المكتب المنفصل استخدامه أثناء تشغيله.",
  "settings.separateDesktop.memoryOption": "{gb} غيغابايت",
  "settings.separateDesktop.shares": "المجلدات المشتركة: {names}",
  "settings.separateDesktop.internet": "الإنترنت مفعّل لهذه المهمة",
  "settings.separateDesktop.reset": "إعادة تعيين سطح المكتب المنفصل",
  "settings.separateDesktop.resetHint":
    "يحذف الحاوية وكل ما حُفظ داخلها. لا تتأثر المجلدات التي شاركتها.",
  "blocks.folder.sd.explain.ro":
    "يريد {persona} السماح لسطح المكتب المنفصل بقراءة الملفات في مجلد.",
  "blocks.folder.sd.explain.rw":
    "يريد {persona} السماح لسطح المكتب المنفصل بقراءة الملفات في مجلد وتغييرها. يمكن للبرامج في سطح المكتب المنفصل تغيير الملفات هناك، وتظهر التغييرات على هذا الكمبيوتر.",
  "blocks.folder.sd.scope":
    "يرى سطح المكتب المنفصل هذا المجلد خلال هذه المهمة فقط. لا يُشارك أي شيء آخر على هذا الكمبيوتر، ولا تحصل أي أداة أخرى على هذا الكمبيوتر على المجلد.",
  "blocks.folder.sd.scope.once": "هذه المهمة فقط",
  "settings.separateDesktop.limitMemory": "حد الذاكرة غير مطبّق على هذا النظام",
  "settings.separateDesktop.limitPids": "حد العمليات غير مطبّق على هذا النظام",
  "blocks.details.sdUnverified":
    "لا يستطيع سطح المكتب المنفصل التأكد من أن هذه الصفحة هي فعلاً {origin}. تابع فقط إذا كنت تثق بالمكان الذي أرسلتك إليه المهمة.",
  "blocks.details.sdFiles": "الملفات",
  "blocks.details.sdAlsoChanges": "يمكن لهذه المهمة أيضًا تغيير {folder} وإرسال ملفات منه.",
};
