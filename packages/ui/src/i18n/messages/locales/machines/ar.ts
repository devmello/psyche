import type { Catalogue } from "../../index.ts";

/** Computers Psyche can use (ar); merged into `../ar.ts`. */
export const machines: Partial<Catalogue> = {
  "machines.title": "الحواسيب التي يستطيع Psyche استخدامها",
  "machines.description":
    "حواسيب Linux اقترنتَ بها ليستخدم Psyche التطبيقات والأوامر والملفات هناك بينما تواصل استخدام هذا الحاسوب.",
  "machines.empty":
    "امنح Psyche حاسوب Linux ليعمل عليه، فيستخدم التطبيقات والأوامر والملفات هناك بينما تواصل استخدام هذا الحاسوب.",
  "machines.add": "إضافة حاسوب Linux",
  "machines.add.description":
    "يعمل Psyche على ذلك الحاسوب بينما تواصل استخدام هذا الحاسوب. تتبع الإجراءات هناك إعدادات الموافقة لديك.",
  "machines.add.account": "أي حساب يجب أن يستخدمه Psyche هناك؟",
  "machines.add.account.own": "حسابك (موصى به)",
  "machines.add.account.ownHint":
    "يستطيع Psyche استخدام ملفاتك وتطبيقاتك وتسجيلات دخولك هناك كما تفعل أنت. ولا يحصل أبدًا على صلاحية root.",
  "machines.add.account.dedicated": "حساب psyche منفصل",
  "machines.add.account.dedicatedHint":
    "لا يرى Psyche إلا ملفات ذلك الحساب وتطبيقاته. ليس لديه sudo ولا كلمة مرور.",
  "machines.add.needsNetwork":
    "لا تستطيع الحواسيب الأخرى الوصول إلى هذا الحاسوب بعد. فعّل أولًا الوصول عن بُعد أو الوصول عبر الشبكة المحلية في الإعدادات ← الخادم والوصول عن بُعد.",
  "machines.add.make": "عرض الأوامر",
  "machines.add.again": "إنشاء أوامر جديدة",
  "machines.add.commands": "أوامر حاسوب Linux",
  "machines.add.installStep": "1. على حاسوب Linux، ثبّت المساعد",
  "machines.add.pairStep": "2. ابدأ الاقتران هناك",
  "machines.add.expires": "يعمل الرابط مرة واحدة وتنتهي صلاحيته {when}.",
  "machines.add.waiting": "في انتظار اقتران الحاسوب…",
  "machines.add.paired": "اقترن {name}. يستطيع Psyche استخدامه الآن.",
  "machines.add.pairedToast": "تمت إضافة {name}",
  "machines.add.done": "تم",
  "machines.copy": "نسخ",
  "machines.status.online": "متصل",
  "machines.status.offline": "غير متصل",
  "machines.status.degraded": "يحتاج إلى انتباه",
  "machines.display.headless": "شاشة خاصة",
  "machines.display.desktopSession": "سطح مكتب خاص به",
  "machines.display.container": "حاوية",
  "machines.thisComputer": "هذا الحاسوب",
  "machines.watch": "مشاهدة",
  "machines.watchNamed": "مشاهدة {name}",
  "machines.apps": "وصول التطبيقات",
  "machines.appsNamed": "وصول التطبيقات على {name}",
  "machines.folders": "المجلدات",
  "machines.foldersNamed": "المجلدات على {name}",
  "machines.rename.action": "إعادة تسمية",
  "machines.rename.named": "إعادة تسمية {name}",
  "machines.rename.label": "اسم جديد لـ {name}",
  "machines.rename.save": "حفظ",
  "machines.rename.cancel": "إلغاء",
  "machines.remove": "إزالة",
  "machines.removeTitle": "إزالة {name}؟",
  "machines.removeDescription":
    "يتوقف Psyche عن استخدام {name} فورًا ويُلغى اقترانه. لاستخدامه مجددًا، اقترن به من جديد.",
  "machines.err.nameTaken": "يوجد حاسوب آخر بهذا الاسم بالفعل، أو أنه محجوز. اختر اسمًا مختلفًا.",
  "machines.err.nameInvalid":
    "لا يمكن استخدام هذا الاسم. استخدم حروفًا وأرقامًا وعلامات ترقيم عادية بحد أقصى 64 حرفًا، ولا تخلط بين حروف متشابهة الشكل.",
  "machines.err.forbidden": "تتطلب إعادة التسمية جهازًا مسؤولًا. جرّب مرة أخرى من أحدها.",
  "machines.err.failed": "لم تنجح العملية ({reason}). لم يتغير شيء.",
  "machines.account.own":
    "يعمل بحسابك الخاص على {name}. يستطيع Psyche استخدام ملفاتك وتطبيقاتك وتسجيلات دخولك هناك كما تفعل أنت. ولو اختُرق Psyche يومًا لاستطاع المهاجم ذلك أيضًا، عدا root الذي لا يحصل عليه Psyche أبدًا.",
  "machines.account.dedicated":
    "يعمل بحساب منفصل على {name}. لا يرى Psyche إلا ملفات ذلك الحساب وتطبيقاته.",
  "machines.account.useSeparate": "استخدام حساب منفصل بدلًا من ذلك…",
  "machines.account.useSeparateHint":
    "على {name}، شغّل برنامج التثبيت مرة أخرى بخيار الحساب المنفصل، ثم اقترن به من جديد:",
  "machines.shell.contained": "تعمل الأوامر في صدفة معزولة",
  "machines.shell.full": "تعمل الأوامر في الصدفة الكاملة للحساب",
  "machines.shell.off": "الأوامر متوقفة",
  "machines.limits.folders":
    "{count, plural, =0 {لم تُمنح أي مجلدات} one {مُنح مجلد #} other {مُنحت # مجلدات}}",
  "machines.helperVersion": "المساعد {version}",
  "machines.helperVersionUnknown": "إصدار المساعد غير معروف",
  "machines.update": "يتوفر مساعد أحدث. حدّث المساعد على {name}:",
  "machines.warnings": "تحذيرات {name}",
  "machines.warn.fullShell":
    "الصدفة الكاملة للحساب. الأوامر غير معزولة، لذا تصل إلى كل ما يصل إليه هذا الحساب.",
  "machines.warn.userLimits":
    "الحدود مملوكة للمستخدم. أي برنامج يعمل بهذا الحساب يمكنه تغيير ما يُسمح لـ Psyche بفعله على {name}.",
  "machines.warn.sudo":
    "لهذا الحساب sudo دون كلمة مرور. لا يستطيع Psyche استخدام sudo هنا، لكن برامج أخرى تشغّلها بهذا الحساب تستطيع.",
  "machines.paired": "اقترن {when}",
  "machines.line": "على «{name}» · Linux · {place}",
  "machines.place.screen": "شاشة خاصة",
  "machines.place.desktop": "سطح مكتبه",
  "machines.place.command": "أمر",
  "machines.place.files": "ملفات",
  "machines.step.on": "{label} على {name}",
  "machines.picker.title": "الحواسيب",
  "machines.picker.description":
    "اختر الحاسوب الذي تنطبق عليه هذه الإعدادات، والمكان الذي يعمل فيه Psyche حين لا تراقب حاسوبًا بعينه.",
  "machines.picker.show": "عرض وصول التطبيقات لـ",
  "machines.picker.default": "الحاسوب الافتراضي للعمل في الخلفية",
  "machines.picker.defaultHint":
    "تعمل المهام والأتمتة هناك ما لم تُسمِّ حاسوبًا. اختر حاسوب Linux ليعمل Psyche هناك بينما تعمل أنت هنا.",
  "machines.picker.appsOn": "التطبيقات على {name}",
  "machines.picker.appsHint": "يزامن Psyche هذه مع {name} ولا يتجاوز أبدًا حدود ذلك الحاسوب نفسه.",
  "machines.picker.noApps": "لم ير Psyche أي تطبيقات على {name} بعد. ستظهر هنا حين يراها.",
  "machines.picker.offline": "{name} غير متصل. تصله التغييرات حين يعاود الاتصال.",
  "computerWatch.titleMachine": "{name} · شاشة خاصة",
  "computerWatch.machineOffline": "تعذّر الوصول إلى {name}. تجري إعادة المحاولة…",
  "computerWatch.empty.bodyMachine": "حين يحتاج الوكيل إلى شاشة على {name}، يمكنك مشاهدتها هنا.",
  "notice.machine.working.title": "يعمل Psyche على {name}",
  "notice.machine.working.body":
    "يستخدم شاشة ذلك الحاسوب أو تطبيقاته أو ملفاته. شاهده من الإعدادات ← الأجهزة.",
  "notice.machine.offline.title": "انقطع اتصال {name}",
  "notice.machine.offline.body":
    "لا يستطيع Psyche استخدامه حتى يعاود الاتصال. المهام التي تحتاج إليه تنتظرك.",
  "machines.add.linkStep": "3. عندما يطلب الرابط، الصق هذا",
  "machines.add.installSource":
    "احصل على حزمة المساعد من {url} وفك ضغطها، ثم شغّل هذا على حاسوب Linux.",
  "machines.reports": "{name} يُبلغ:",
  "computerWatch.machineLoading": "جارٍ تحميل الحاسوب…",
  "computerWatch.machineMissing": "هذا الحاسوب غير متاح.",
  "settings.key.computerUse.defaultMachine": "الحاسوب الافتراضي للعمل في الخلفية",
  "settings.key.computerUse.machineApps": "وصول التطبيقات على حاسوب Linux",
  "machines.card.folder": "المجلد",
  "machines.card.runsContained":
    "معزول، في المجلد الممنوح فقط: لا مفاتيح ولا ملفات تعريف المتصفح ولا مجلدات أخرى",
  "machines.card.runsFullAccount": "على الحساب الكامل: يمكنه فعل أي شيء يستطيعه ذلك الحساب",
  "machines.card.networkOff": "متوقفة",
  "machines.card.networkOn": "مفعّلة",
  "machines.card.folderReadOnly": "{path}، للقراءة فقط",
  "machines.card.folderReadWrite": "{path}، للقراءة والكتابة",
  "machines.card.folderNotEnforced": "{path}، القراءة فقط غير مفروضة على الحساب الكامل",
};
