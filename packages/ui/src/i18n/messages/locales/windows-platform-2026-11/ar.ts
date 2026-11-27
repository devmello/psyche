import type { Catalogue } from "../../index.ts";

/** Windows variants of the sandbox PC, voice keys and platform terms, and Mac wording (ar); merged into `../ar.ts`. */
export const windowsPlatform202611: Partial<Catalogue> = {
  "blocks.details.runsNoHostSandbox":
    "على هذا الكمبيوتر، بدون بيئة معزولة: لا توجد بيئة معزولة للأوامر هنا",
  "blocks.execHost.noHostSandbox":
    "لا توجد بيئة معزولة للأوامر على هذا الكمبيوتر، لذلك لا يمكن تشغيل هذا الأمر إلا بدونها. اكتب {word} لتشغيله هذه المرة فقط.",
  "blocks.execHost.mustTypeOnly": "اكتب {word} للسماح به.",
  "settings.uninstall.stopSandboxPc":
    "تتم إزالة خدمة جهاز البيئة المعزولة. يطلب Windows موافقة المسؤول مرة واحدة.",
  "settings.computerUse.tcc.microphone.name": "الميكروفون",
  "settings.computerUse.tcc.microphone.why": "يتيح لـ Psyche سماعك للإملاء وملاحظات الاجتماعات",
  "settings.sandbox.restart.reopen": "أغلق Psyche ثم افتحه من جديد.",
  "settings.sandbox.pc.title": "تشغيل جهاز البيئة المعزولة",
  "settings.sandbox.pc.body":
    "لا يعمل srt، البيئة المعزولة الخفيفة لـ Psyche للأوامر، على Windows. بدلًا من ذلك، تعمل السكربتات وخوادم الأوامر والموصلات التي ينشئها Psyche داخل الخصوصية والأمان → استخدام الكمبيوتر → وضع VM: كمبيوتر Linux صغير خاص به، لا يملك وصولًا إلى ملفاتك. فعّله من الإعدادات ← جهاز البيئة المعزولة، ثم تحقق مرة أخرى.",
  "settings.sandbox.pc.notReady.title": "جهاز البيئة المعزولة غير جاهز بعد",
  "settings.sandbox.pc.notReady.body":
    "هو مُفعّل، لكنه لا يعمل بعد، أو أن Psyche داخله قديم. ابدأ تشغيله أو حدّثه من الإعدادات ← الخصوصية والأمان → استخدام الكمبيوتر → وضع VM، ثم تحقق مرة أخرى.",
  "settings.sandbox.pc.ready":
    "جهاز البيئة المعزولة مُفعّل: تعمل فيه السكربتات وخوادم الأوامر والموصلات التي ينشئها Psyche.",
  "settings.sandbox.pc.open": "فتح إعدادات جهاز البيئة المعزولة",
  "settings.sandbox.pc.where": "يوجد في الإعدادات ← الخصوصية والأمان → استخدام الكمبيوتر → وضع VM.",
  "settings.devices.platform.windows": "كمبيوتر Windows",
  "settings.devices.nodeKind.winHelper": "مساعد Windows",
  "settings.devices.thisPcAdmin":
    "هذا الكمبيوتر هو جهاز المسؤول. يمكن لجهاز مسؤول آخر إلغاء صلاحيته من هنا.",
  "settings.devices.presenceKey.windowsHello":
    "مفتاح Windows Hello ({algorithm})، كما أبلغ عنه المساعد",
  "settings.devices.presenceKey.windowsHelloNoAlgorithm":
    "مفتاح Windows Hello، كما أبلغ عنه المساعد",
  "settings.shortcut.reserved.windowsKey": "Windows (الاختصارات التي تستخدم مفتاح Windows)",
  "settings.shortcut.reserved.windowMenu": "قائمة النوافذ",
  "settings.shortcut.reserved.closeApp": "إغلاق التطبيقات",
  "settings.shortcut.reserved.taskManager": "مدير المهام",
  "settings.shortcut.reserved.startMenu": "قائمة ابدأ",
  "settings.shortcut.reserved.securityScreen": "شاشة أمان Windows",
  "settings.shortcut.key.Super": "مفتاح Windows",
  "settings.shortcut.useDefault": "استخدام الافتراضي",
  "settings.quickEntry.title": "الإدخال السريع",
  "settings.key.quickEntry.shortcut": "الاختصار",
  "settings.quickEntry.shortcutHint":
    "يفتح الدردشة المنبثقة من أي تطبيق. ما لم تختر مفاتيح أخرى، يستخدم Psyche {keys}، أو {fallback} عندما يستخدمه تطبيق آخر.",
  "settings.voice.key.rightCtrl": "Ctrl الأيمن",
  "settings.voice.key.rightAlt": "Alt الأيمن",
  "settings.voice.key.rightShift": "Shift الأيمن",
  "settings.voice.key.rightWin": "مفتاح Windows الأيمن",
  "settings.voice.key.capsLock": "Caps Lock",
  "settings.voice.key.scrollLock": "Scroll Lock",
  "settings.voice.key.pause": "Pause",
  "settings.voice.key.menu": "مفتاح القائمة",
  "settings.voice.key.insert": "Insert",
  "settings.voice.key.numLock": "Num Lock",
  "settings.voice.key.other": "مفتاح آخر",
  "settings.voice.key.press": "اضغط على مفتاح",
  "settings.voice.key.pressNow": "اضغط على المفتاح الذي تريد إبقاءه مضغوطًا…",
  "settings.voice.key.cantUse":
    "هذا المفتاح يكتب نصًا، لذلك لا يمكن إبقاؤه مضغوطًا للتحدث. جرّب Ctrl الأيمن أو Caps Lock أو Pause أو مفتاح القائمة أو من F13 إلى F24.",
  "settings.voice.key.capsLockHint":
    "يحتفظ Caps Lock بحالته مُفعّلًا أو مُعطّلًا: إبقاؤه مضغوطًا للتحدث لا يغيّر حالته، والضغطة السريعة ما زالت تبدّلها.",
  "settings.voice.key.altGrWarning":
    "في تخطيط لوحة المفاتيح لديك، Alt الأيمن هو AltGr الذي يكتب رموزًا مثل @ أو €. إبقاؤه مضغوطًا للتحدث قد يعيق كتابة هذه الرموز؛ Ctrl الأيمن أكثر أمانًا.",
  "settings.voice.access.windowsWhy":
    "يراقب المفتاح الذي تبقيه مضغوطًا ويكتب في التطبيق المُركّز عليه. لا يحتاج Windows إلى إذن لذلك؛ التطبيقات التي تعمل كمسؤول لا تستقبل النص المُملى.",
  "settings.voice.model.title": "نموذج الكلام",
  "settings.voice.model.usingHelper":
    "يستخدم الإملاء التعرّف على الكلام الخاص بالمساعد. يُحوّل نموذج الكلام الكلام إلى نص بدقة أكبر، ويعمل على هذا الـ Mac.",
  "settings.voice.model.download": "نزّل نموذج الكلام ({mb} MB) لإملاء أفضل",
  "settings.voice.model.downloadHint":
    "تنزيل لمرة واحدة من مشروع whisper.cpp، يُتحقق منه قبل الاستخدام. لا يغادر الصوت هذا الـ Mac أبدًا.",
  "settings.voice.model.downloading": "جارٍ تنزيل نموذج الكلام: {received} من {total} MB",
  "settings.voice.model.ready": "Whisper ({model}) على هذا الـ Mac",
  "settings.voice.model.readyHint":
    "يُحوَّل الإملاء والتسجيلات إلى نص هنا؛ ولا يغادر الصوت الـ Mac أبدًا.",
  "settings.voice.model.readyNotFirst":
    "مُثبّت. ترتيب المحركات لديك يضع محركًا آخر أولًا، لذلك لا يستخدمه الإملاء الآن.",
  "settings.voice.model.failed": "فشل التنزيل: {reason}",
  "settings.voice.model.retry": "حاول مرة أخرى",
  "settings.voice.model.vcredist":
    "يحتاج نموذج الكلام إلى Microsoft Visual C++ Redistributable. ثبّته، ثم أملِ مرة أخرى.",
  "settings.voice.model.crashed":
    "توقف محرك الكلام بشكل غير متوقع؛ يستخدم الإملاء المساعد حتى يُعاد تشغيله.",
  "settings.sandboxPc.title": "تشغيل جهاز البيئة المعزولة",
  "settings.sandboxPc.explain":
    "يحصل {persona} على كمبيوتر Linux خاص صغير يعمل داخل Windows. تعمل المهام هناك بدلًا من جهازك، ولا ترى إلا المجلدات التي تشاركها.",
  "settings.sandboxPc.oneTime":
    "إعداد لمرة واحدة: يطلب Windows موافقة المسؤول مرة واحدة لإضافة خدمة في الخلفية تشغّل الكمبيوتر. بعدها يُنزّل Psyche صورة الكمبيوتر ({download}، و{disk} على القرص). لا يحتاج أي شيء آخر إلى مسؤول.",
  "settings.sandboxPc.oneTimeNoSize":
    "إعداد لمرة واحدة: يطلب Windows موافقة المسؤول مرة واحدة لإضافة خدمة في الخلفية تشغّل الكمبيوتر. بعدها يُنزّل Psyche صورة الكمبيوتر. لا يحتاج أي شيء آخر إلى مسؤول.",
  "settings.sandboxPc.turnOn": "تشغيل جهاز البيئة المعزولة",
  "settings.sandboxPc.cancelDownload": "إلغاء التنزيل",
  "settings.sandboxPc.waitingAdmin": "بانتظار مطالبة المسؤول…",
  "settings.sandboxPc.restarting": "جارٍ إنهاء الإعداد…",
  "settings.sandboxPc.downloading": "جارٍ تنزيل صورة الكمبيوتر: {received} من {total}",
  "settings.sandboxPc.progressLabel": "تنزيل صورة الكمبيوتر",
  "settings.sandboxPc.ready": "تم الإعداد",
  "settings.sandboxPc.readyText": "تم إعداد جهاز البيئة المعزولة. الإصدار {version}.",
  "settings.sandboxPc.unsupported": "جهاز البيئة المعزولة غير متاح هنا: {reason}.",
  "settings.sandboxPc.failed": "تعذّر تشغيل جهاز البيئة المعزولة: {reason}",
  "settings.sandboxPc.failedDid": "لم يتغير شيء آخر. يمكنك المحاولة مرة أخرى.",
  "settings.sandboxPc.gb": "{value, number} GB",
  "settings.sandboxPc.mb": "{value, number} MB",
  "settings.sandboxPc.loadLabel": "جهاز البيئة المعزولة",
  "settings.sandboxPc.onboarding": "جهاز البيئة المعزولة",
  "settings.sandboxPc.onboardingHint":
    "اختياري: كمبيوتر Linux خاص للمهام التي لا يجب أن تمس ملفاتك. يمكنك إعداده لاحقًا من الإعدادات.",
  "settings.sandboxPc.update.title": "تحديث خدمة جهاز البيئة المعزولة",
  "settings.sandboxPc.update.explainCompatible":
    "يأتي هذا الإصدار من Psyche مع خدمة جهاز بيئة معزولة أحدث من المُثبّتة. سيستمر جهاز البيئة المعزولة في العمل كما هو.",
  "settings.sandboxPc.update.explainRequired":
    "لا يستطيع هذا الإصدار من Psyche استخدام خدمة جهاز البيئة المعزولة المُثبّتة. سيبقى جهاز البيئة المعزولة مُطفأً حتى تحدّثه.",
  "settings.sandboxPc.update.available": "يتوفر تحديث",
  "settings.sandboxPc.update.required": "التحديث مطلوب",
  "settings.sandboxPc.update.versions": "المُثبّت: {installed}. هذا الإصدار من Psyche: {bundled}.",
  "settings.sandboxPc.update.oneStep":
    "يطلب Windows موافقة المسؤول مرة واحدة. يتوقف جهاز البيئة المعزولة الذي يعمل أثناء استبدال الخدمة.",
  "settings.sandboxPc.update.button": "تحديث خدمة جهاز البيئة المعزولة",
  "settings.sandboxPc.update.failed": "لم تُحدَّث خدمة جهاز البيئة المعزولة: {reason}",
  "settings.sandboxPc.update.failedDid": "لم يتغير شيء آخر. يمكنك المحاولة مرة أخرى.",
  "settings.sandboxPc.controls.title": "جهاز البيئة المعزولة",
  "settings.sandboxPc.controls.hint": "أنشئه مرة واحدة، ثم ابدأه وأوقفه من هنا.",
  "settings.sandboxPc.controls.create": "إنشاء جهاز البيئة المعزولة",
  "settings.sandboxPc.controls.start": "ابدأ",
  "settings.sandboxPc.controls.stop": "أوقف",
  "settings.sandboxPc.controls.resume": "استئناف",
  "settings.sandboxPc.controls.working": "جارٍ العمل…",
  "settings.sandboxPc.controls.helperOffline":
    "مساعد Windows لا يعمل، أو ليس لديه جهاز البيئة المعزولة بعد، لذلك لا يمكن التحكم به. أعد تشغيل المساعد من الإعدادات ← الأجهزة.",
  "settings.sandboxPc.controls.failed": "لم ينجح ذلك: {reason}",
  "settings.sandboxPc.controls.waitForImage": "أكمل التفعيل أعلاه أولًا.",
  "settings.sandboxPc.snapshots.title": "اللقطات",
  "settings.sandboxPc.snapshots.hint":
    "احفظ قرص جهاز البيئة المعزولة للعودة إليه لاحقًا. يجب أن يكون متوقفًا للحفظ أو الاستعادة.",
  "settings.sandboxPc.snapshots.none": "لا توجد لقطات بعد.",
  "settings.sandboxPc.snapshots.save": "احفظ لقطة",
  "settings.sandboxPc.snapshots.saveFresh": "احفظ كجهاز جديد",
  "settings.sandboxPc.snapshots.reset": "أعِد إلى الجهاز الجديد",
  "settings.sandboxPc.snapshots.restore": "استعادة",
  "settings.sandboxPc.snapshots.delete": "حذف",
  "settings.sandboxPc.snapshots.fresh": "الجهاز الجديد",
  "settings.sandboxPc.snapshots.item": "{label}، {when}",
  "settings.sandboxPc.snapshots.stopFirst": "أوقف جهاز البيئة المعزولة أولًا.",
  "onboarding.connectors.windowsHint":
    "على Windows، يقرأ {name} بريدك وتقويمك وجهات اتصالك عبر حساب Microsoft أو Google أو IMAP.",
  "web.about.windowsArm": "Arm64",
  "web.about.windowsX64": "x64",
  "web.about.windowsBuild": "الإصدار {build}",
  "platform.term.os": "macOS",
  "platform.term.device": "Mac",
  "platform.term.thisDevice": "هذا الـ Mac",
  "platform.term.thisDeviceLower": "هذا الـ Mac",
  "platform.term.presence": "Touch ID",
  "platform.term.secretStore": "Keychain",
  "platform.term.systemSettings": "إعدادات النظام",
  "platform.term.fileManager": "Finder",
  "platform.term.trayArea": "شريط القوائم",
  "platform.term.taskbar": "Dock",
  "platform.term.systemSearch": "Spotlight",
  "platform.term.helper": "مساعد Mac",
  "platform.term.terminal": "Terminal",
  "platform.term.alt": "Option",
  "platform.term.mod": "Command",
  "platform.macOnly": "متاح على macOS فقط",
  "platform.macOnlyHint": "يحتاج {name} إلى Mac. يمكن لـ Psyche على macOS استخدامه.",
  "platform.windows.access.title": "صلاحيات Windows",
  "platform.windows.access.hint": "ما الذي يسمح Windows لـ Psyche بفعله، وما الذي يطلبه منك.",
  "platform.windows.access.noPermission": "لا يحتاج إلى إذن",
  "platform.windows.access.uiAutomation.name": "استخدام التطبيقات",
  "platform.windows.access.uiAutomation.why":
    "يقرأ {persona} نوافذ التطبيقات ويستخدمها عبر Windows UI Automation. لا يسمح Windows له بالتحكم في التطبيقات التي تعمل كمسؤول.",
  "platform.windows.access.screen.name": "التقاط الشاشة",
  "platform.windows.access.screen.why":
    "لا يحتاج Windows إلى إذن لالتقاط الشاشة. تُخفى نوافذ Psyche وحقول كلمات المرور في الالتقاطات.",
  "platform.windows.access.microphone.name": "الميكروفون",
  "platform.windows.access.microphone.why":
    "للإملاء وملاحظات الاجتماعات. يطلب Windows ذلك من الإعدادات ← الخصوصية والأمان ← الميكروفون، مع تفعيل «السماح لتطبيقات سطح المكتب بالوصول إلى الميكروفون».",
  "platform.windows.access.openSettings": "فتح الإعدادات",
  "platform.windows.access.openSettingsFor": "فتح إعدادات Windows لـ {name}",
  "platform.windows.access.state.granted": "مُفعّل",
  "platform.windows.access.state.denied": "مُعطّل في إعدادات Windows",
  "platform.windows.access.state.not_determined": "لم يُتحقق منه بعد",
  "platform.helper.restart": "إعادة تشغيل المساعد",
  "platform.helper.restarting": "جارٍ إعادة التشغيل…",
  "platform.helper.restartFailed": "لم يبدأ المساعد ({reason}).",
};
