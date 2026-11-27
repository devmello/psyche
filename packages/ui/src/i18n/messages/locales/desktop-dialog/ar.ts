import type { Catalogue } from "../../index.ts";

/** Native dialogs and notifications (ar); merged into `../ar.ts`. */
export const desktopDialog: Partial<Catalogue> = {
  "desktop.dialog.notificationsOn": "الإشعارات مفعّلة.",
  "desktop.dialog.anotherCopyTitle": "نسخة أخرى من Psyche تعمل بالفعل",
  "desktop.dialog.anotherCopyDetail":
    "تعمل من {path}. استخدام هذه النسخة يحوّل Psyche إلى هذا التطبيق، وتتصل النسخة الأخرى بهذه النسخة بعد ذلك.",
  "desktop.dialog.keepOtherCopy": "الإبقاء على النسخة الأخرى",
  "desktop.dialog.useThisCopy": "استخدام هذه النسخة",
  "desktop.dialog.cancel": "إلغاء",
  "desktop.dialog.ok": "حسنًا",
  "desktop.dialog.shareFolderTitle": "مشاركة مجلد مع Psyche",
  "desktop.dialog.share": "مشاركة",
  "desktop.dialog.gatewaysFileTitle": "تعذّر على Psyche قراءة بوابات الاتصال المحفوظة",
  "desktop.dialog.gatewaysFileDetail":
    "{problem}. يبدأ Psyche على {os, select, macos {هذا Mac} windows {هذا الكمبيوتر} other {هذا الكمبيوتر}} ويترك الملف كما هو، فلا تضيع أي هوية مثبّتة. أصلح الملف أو احذفه في مجلد بيانات Psyche لاستخدام بوابة كمبيوتر آخر.",
  "desktop.dialog.stillRunningTitle": "لا يزال Psyche يعمل",
  "desktop.dialog.stillRunningBody":
    "تستمر المهام والأتمتة في العمل. افتح Psyche من أيقونته في منطقة الإشعارات، وانقر عليها بزر الفأرة الأيمن للخروج.",
  "desktop.dialog.manualStepsTitle": "خطوة أخيرة لإكمال إزالة Psyche",
  "desktop.dialog.uninstallTitle": "إلغاء تثبيت Psyche؟",
  "desktop.dialog.uninstall": "إلغاء التثبيت",
  "desktop.dialog.uninstallAndDelete": "حذف البيانات وإلغاء التثبيت",
  "desktop.dialog.uninstallItems":
    "{count, plural, one {سينتقل # عنصر} other {ستنتقل # عنصرًا}} إلى سلة المهملات، بما في ذلك Psyche.app.",
  "desktop.dialog.uninstallDataFolder": "سينتقل مجلد بياناتك {folder} إلى سلة المهملات أيضًا.",
  "desktop.dialog.uninstallDataKept": "سيُحتفظ بمجلد بياناتك.",
  "desktop.dialog.uninstallKeychain": "ستُحذف عناصر سلسلة المفاتيح التي يحتفظ بها Psyche.",
  "desktop.dialog.uninstallKeychainKept":
    "تبقى عناصر سلسلة المفاتيح؛ احذفها من «الوصول إلى سلسلة المفاتيح» إن أردت.",
  "desktop.dialog.stopTitle":
    "إيقاف Psyche على {os, select, macos {هذا Mac} windows {هذا الكمبيوتر} other {هذا الكمبيوتر}}؟",
  "desktop.dialog.stopDetail": "تتوقف أتمتته ومهامه المجدولة حتى تعود إليه. اتركه يعمل لتستمر.",
  "desktop.dialog.stopButton":
    "إيقاف Psyche على {os, select, macos {هذا Mac} windows {هذا الكمبيوتر} other {هذا الكمبيوتر}}",
  "desktop.dialog.keepRunning": "إبقاؤه قيد التشغيل",
  "desktop.dialog.forgetTitle": "نسيان {name}؟",
  "desktop.dialog.forgetDetail":
    "{origin}\n\nيؤدي هذا إلى حذف مفتاح هذا الكمبيوتر له وكل ما خزّنه Psyche هنا من أجله. سيظل {name} يعرض هذا الكمبيوتر حتى يحذفه أحد هناك.",
  "desktop.dialog.forgetButton": "نسيان",
  "desktop.dialog.repairTitle": "إعادة الإقران مع {name}؟",
  "desktop.dialog.repairDetail":
    "{origin}\n\nيؤدي هذا إلى نسيان الهوية التي ثبّتها Psyche له ومفتاح هذا الكمبيوتر، فيثبّت الاتصال التالي ما يردّ على ذلك العنوان ويطلب الإقران كجهاز جديد. افعل هذا فقط إذا كنت تعرف سبب تغيّر هويته.",
  "desktop.dialog.repairButton": "إعادة الإقران",
  "desktop.dialog.claimTitle": "إعداد خادم Psyche على {origin}؟",
  "desktop.dialog.claimDetail":
    "يتحقق Psyche من أن الخادم يعرف رمز الإعداد الذي كتبته قبل أن يثق به، ويتحقق الخادم من أن هذا الكمبيوتر يعرفه قبل أن يجعله مسؤول الخادم. تابع فقط إذا كنت قد ثبّتّ ذلك الخادم بنفسك للتو.",
  "desktop.dialog.setUp": "إعداد",
  "desktop.dialog.addLanTitle": "هل {origin} هو Psyche على هذه الشبكة؟",
  "desktop.dialog.addLanDetail":
    "الاسم: {name}\n\nيستخدم Psyche على هذه الشبكة شهادته الخاصة، التي يثبّتها Psyche بدلًا من الوثوق بشهادة النظام: يتحقق من الشهادة ومفتاح البوابة عند أول اتصال، ويرفض أي شهادة أخرى بعد ذلك. اختر «‏HTTPS عادي» فقط لخادم بشهادة اعتيادية (مثل وكيل عكسي بسلطة شهادات خاصة بك). لا يُشارَك شيء حتى يوافق مالكه على هذا الكمبيوتر هناك.",
  "desktop.dialog.psycheOnNetwork": "Psyche على هذه الشبكة",
  "desktop.dialog.plainHttps": "‏HTTPS عادي",
  "desktop.dialog.addLinkTitleLan": "ربط Psyche بـ {origin} على هذه الشبكة؟",
  "desktop.dialog.addLinkTitle": "ربط Psyche بـ {origin}؟",
  "desktop.dialog.addLinkDetail":
    "{external, select, yes {فتح هذا الرابط تطبيق آخر أو موقع ويب، ولم تلصقه أنت. تابع فقط إذا أنشأته بنفسك على {os, select, macos {الـ Mac} windows {الكمبيوتر} other {الكمبيوتر}} الذي يشغّل Psyche.\n\n} other {}}لن يتصل Psyche إلا إذا أثبتت هذه البوابة هذه الهوية:\n{fingerprint}\n\n{lan, select, yes {تستخدم شهادتها الخاصة، لا شهادة يثق بها النظام. يثبّتها Psyche على الشهادة التي يذكرها هذا الرابط ({pin}…) قبل إرسال أي شيء، ويرفض أي شهادة أخرى. تابع فقط إذا جاء الرابط من {os, select, macos {Mac} windows {PC} other {كمبيوترك}} الخاص على هذه الشبكة.\n\n} other {}}ثم يتيح رمز الرابط لمرة واحدة لتلك البوابة أن توافق على هذا الكمبيوتر دون أن تسأل مجددًا، بالصلاحية التي اختارها مالكها عند إنشائه.",
  "desktop.dialog.addDetailKey":
    "الاسم: {name}\nالمفتاح الذي أعلنته: {key}…\n\nسيطلب هذا الكمبيوتر من تلك البوابة الإقران. لا يُشارَك شيء حتى يوافق مالكها على هذا الكمبيوتر هناك، ويثبّت Psyche هوية البوابة عند أول اتصال.",
  "desktop.dialog.addDetailPlain":
    "الاسم: {name}\n\nسيطلب هذا الكمبيوتر من تلك البوابة الإقران. لا يُشارَك شيء حتى يوافق مالكها على هذا الكمبيوتر هناك، ويثبّت Psyche هوية البوابة عند أول اتصال.",
  "desktop.dialog.addGatewayButton": "إضافة بوابة",
};
