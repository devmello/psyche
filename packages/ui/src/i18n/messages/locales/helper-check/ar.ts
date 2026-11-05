import type { Catalogue } from "../../index.ts";

/** The Linux helper check in Settings → Devices (ar); merged into `../ar.ts`. */
export const helperCheck: Partial<Catalogue> = {
  "settings.devices.helperCheck.title": "فحص مساعد Linux",
  "settings.devices.helperCheck.description":
    "عند اتصال مساعد Linux، يتحقق Psyche من هوية البرنامج فعلًا.",
  "settings.devices.helperCheck.state.verified": "تم التحقق: مساعد مثبّت في النظام",
  "settings.devices.helperCheck.state.userOwned": "لم يتم التحقق: مساعد من مجلدك الشخصي",
  "settings.devices.helperCheck.state.unverified": "لم يتم التحقق: تعذّر على Psyche فحص المساعد",
  "settings.devices.helperCheck.detail.verified":
    "هذا هو المساعد المثبّت مع Psyche. لا يستطيع تغييره إلا النظام.",
  "settings.devices.helperCheck.detail.userOwned":
    "يعمل من ملفات تملكها، مثل AppImage أو إصدار مبني في مجلدك الشخصي. يقبله Psyche، لكنه لا يستطيع استبعاد أن يكون برنامج آخر لك قد استبدله.",
  "settings.devices.helperCheck.detail.unverified":
    "يقبله Psyche حاليًا، لكنه لم يتمكن من معرفة أي برنامج هو.",
  "settings.devices.helperCheck.refused": "مرفوض: {reason}",
  "settings.devices.helperCheck.reason.unclear": "تعذّر على Psyche التحقق من المساعد",
  "settings.devices.helperCheck.reason.notHelper": "هذا البرنامج ليس مساعد Psyche",
  "settings.devices.helperCheck.reason.userCopy":
    "إنه نسخة خارج تثبيت النظام، والمطلوب هو المساعد المثبّت",
  "settings.devices.helperCheck.reason.loaderEnv": "بدأ تشغيله بمسار مكتبات أو بمكتبة محمّلة مسبقًا",
  "settings.devices.helperCheck.reason.foreignCode": "فيه شيفرة محمّلة من خارج النظام",
  "settings.devices.helperCheck.reason.severalPrograms": "أكثر من برنامج يشارك اتصاله",
  "settings.devices.helperCheck.reason.handedOver": "سلّمه برنامج آخر اتصاله",
  "settings.devices.helperCheck.reason.stillStarting": "كان ما يزال قيد البدء",
  "settings.devices.helperCheck.reason.debugged": "هو متوقف أو قيد التنقيح",
  "settings.devices.helperCheck.reason.restartNeeded":
    "تم استبداله أو حُدّثت مكتبة نظام منذ بدء تشغيله؛ أعد تشغيل المساعد",
  "settings.devices.helperCheck.reason.filesNotLocked": "يمكن لجهة غير النظام تغيير ملفاته",
  "settings.devices.helperCheck.reason.otherNamespace":
    "يعمل في بيئة معزولة منفصلة على هذا الكمبيوتر",
  "settings.devices.helperCheck.reason.busy":
    "كان Psyche مشغولًا بفحص اتصالات أخرى؛ سيحاول المساعد مرة أخرى",
  "settings.devices.nodeKind.hostHelper": "مساعد هذا الكمبيوتر",
  "settings.devices.nodeKind.guest": "سطح مكتب منفصل",
};
