import type { Catalogue } from "../../index.ts";

/** web strings (ar); merged into `../ar.ts`. */
export const web: Partial<Catalogue> = {
  "web.remotePresence.title": "Touch ID للموافقات",
  "web.remotePresence.description":
    "تحتاج عمليات الشراء وتعبئة بيانات الاعتماد وأوامر المضيف وتغييرات الأمان إلى Touch ID. أعدّه على هذا الكمبيوتر لتجيب هنا؛ وإلى ذلك الحين تطلب هذه البطاقات الإجابة على {host}. الموافقات العادية لا تحتاج إليه أبدًا.",
  "web.remotePresence.on": "Touch ID مفعّل للموافقات من هذا الكمبيوتر.",
  "web.remotePresence.off": "لم يُعدّ Touch ID على هذا الكمبيوتر.",
  "web.remotePresence.enable": "استخدام Touch ID للموافقات على هذا الكمبيوتر",
  "web.remotePresence.disable": "إيقاف",
  "web.remotePresence.waiting": "بانتظار Touch ID…",
  "web.remotePresence.passkeyName": "Touch ID على هذا الكمبيوتر",
  "web.remotePresence.enabled": "Touch ID مفعّل للموافقات من هذا الكمبيوتر.",
  "web.remotePresence.disabled": "Touch ID للموافقات متوقف على هذا الكمبيوتر.",
  "web.remotePresence.approveOnHost":
    "وافق على «إضافة مفتاح مرور» على {host} بـ Touch ID أو بمفتاح مرور، ثم اضغط الزر مجددًا.",
  "web.remotePresence.unavailable":
    "يحتاج Touch ID إلى Gateway الخاص بـ {host} على عنوان https:// (gateway.publicOrigin). وإلى ذلك الحين أجب عن هذه البطاقات على {host}.",
  "web.touchId.helperDidNotStart":
    "لم يتصل مساعد Psyche. افتح الإعدادات ← الأجهزة لترى السبب ثم حاول مجددًا.",
  "web.panes.title.sidechat": "دردشة جانبية",
  "web.sideChat.about": "دردشة جانبية حول {parent}",
  "web.sideChat.aside": "دردشة جانبية",
  "web.sideChat.expand": "توسيع",
  "web.sideChat.expandTitle": "فتح هذه الدردشة بملء الشاشة",
  "web.terminal.ended": "انتهت الجلسة",
  "web.terminal.waitingApproval": "بانتظار موافقتك…",
  "web.terminal.approvalDenied": "لم تتم الموافقة على Terminal.",
  "web.terminal.approvalTimedOut": "لم تصل الموافقة في الوقت المناسب. افتح Terminal مجددًا.",
  "web.terminal.openOnHost": "افتح Terminal على {host}.",
  "web.terminal.limit": "عدد كبير جدًا من نوافذ Terminal مفتوح على {host}. أغلق واحدة لفتح أخرى.",
  "web.approval.folderNone": "لم يُختر مجلد",
  "web.approval.folderChoose": "اختيار مجلد…",
  "web.approval.messageText": "نص الرسالة، قابل للتعديل قبل الإرسال",
  "web.approval.messageWeak": "SMS/RCS: هوية ضعيفة، تحقق منها",
  "web.approval.messageUntrusted":
    "اقترح هذا المستلم محتوى قرأه Psyche، لا أنت. تحقق منه قبل الإرسال.",
  "web.approval.folderPath": "مسار المجلد",
  "web.approval.folderPickTitle": "مشاركة مجلد",
  "web.browser.stay.question": "البقاء مسجّلًا دخولك إلى {site}؟",
  "web.browser.stay.detail":
    "يحتفظ Psyche بتسجيل الدخول هذا في ملف المتصفح الخاص به لتستخدمه المهام. تبقى كل المواقع الأخرى دون تسجيل دخول.",
  "web.browser.stay.yes": "البقاء مسجّلًا",
  "web.browser.prompt.notNow": "ليس الآن",
  "web.browser.vault.question": "حفظ بيانات الدخول في خزنة Psyche؟",
  "web.browser.vault.account": "{username} على {origin}",
  "web.browser.vault.passwordLabel": "كلمة المرور",
  "web.browser.vault.save": "حفظ بيانات الدخول",
  "web.browser.vault.never": "ليس لهذا الموقع أبدًا",
  "web.browser.vault.error": "تعذّر حفظ بيانات الدخول ({code}). افتح قفل الخزنة وحاول مجددًا.",
  "web.chat.autoUnavailable":
    "الوضع التلقائي غير متاح: {model} ليس ضمن القائمة المسموح بها للوضع التلقائي. اختر نموذجًا آخر لاستخدامه.",
  "web.toast.threadUpdateFailed": "تعذّر على Psyche تغيير إعداد الدردشة هذا.",
  "web.splash.remote.finding": "جارٍ البحث عن {host}…",
  "web.splash.remote.checking": "جارٍ التأكد أنه فعلًا {host}…",
  "web.splash.remote.waiting": "بانتظار الموافقة على {host}…",
  "web.splash.remote.pairCode": "رمز الإقران {code}",
  "web.splash.remote.pairKey": "مفتاح Gateway {fingerprint}",
  "web.splash.remote.pairHint":
    "قارن الاثنين بالطلب في الإعدادات ← الأجهزة على {host}، ثم وافق عليه هناك.",
  "web.splash.remote.pairHintLan":
    "قارن المفتاح كاملًا بالمفتاح في الإعدادات ← الأجهزة على {host}، تحت الطلب الوارد من هذا الكمبيوتر. على الشبكة، المفتاح هو الدليل الوحيد على من أجاب. لا توافق إلا إذا تطابقا.",
  "web.splash.remote.unreachable": "{host} لا يستجيب.",
  "web.splash.remote.unreachableReason":
    "قد يكون في وضع السكون أو مغلقًا، أو قد لا يعمل Psyche هناك، أو قد يكون Tailscale متوقفًا على هذا الكمبيوتر. يواصل Psyche المحاولة.",
  "web.splash.remote.identity": "هذا ليس {host} الذي اقترنت به.",
  "web.splash.remote.identityChanged":
    "مفتاح هويته ليس المفتاح الذي ثبّته هذا الكمبيوتر. ربما يجيب جهاز آخر بدلًا منه، أو أُعيد إعداده.",
  "web.splash.remote.identityMissing": "لم يقدّم مفتاح هوية، لذا لن يتصل Psyche.",
  "web.splash.remote.identityInvalid": "لم يُتحقق من إثبات هويته، لذا لن يتصل Psyche.",
  "web.splash.remote.identityOrigin":
    "أجاب عن عنوان مختلف عن العنوان الذي طلبه هذا الكمبيوتر. على {host}، اضبط العنوان العام في الإعدادات ← الأجهزة ← الخادم والوصول عن بُعد.",
  "web.splash.remote.certChanged":
    "شهادة شبكته ليست الشهادة التي ثبّتها هذا الكمبيوتر. ربما يجيب جهاز آخر على هذه الشبكة بدلًا منه، أو استُبدلت شهادته.",
  "web.splash.remote.certMissing": "لم يضمن الشهادة التي استخدمها، لذا لن يتصل Psyche.",
  "web.splash.remote.certInvalid": "لم يُتحقق من إثباته للشهادة التي استخدمها، لذا لن يتصل Psyche.",
  "web.splash.remote.olderHost": "{host} يشغّل إصدارًا أقدم من Psyche.",
  "web.splash.remote.olderHostReason": "حدّث Psyche على {host} ثم حاول مجددًا.",
  "web.splash.remote.olderApp": "هذا التطبيق أقدم من {host}.",
  "web.splash.remote.olderAppReason": "حدّث Psyche على هذا الكمبيوتر ثم حاول مجددًا.",
  "web.splash.remote.revoked": "أُزيل هذا الكمبيوتر من {host}.",
  "web.splash.remote.revokedReason": "أقرن مجددًا لاستخدامه من هنا، أو انسه.",
  "web.splash.remote.tokenRefused": "رفض {host} رابط الإقران هذا.",
  "web.splash.remote.tokenRefusedReason":
    "استُخدم من قبل، أو انتهت صلاحيته، أو أُلغي. أنشئ رابطًا جديدًا على {host} وأضفه مجددًا.",
  "web.splash.restoredByHand": "أعدتُ بياناتي بنفسي",
  "web.splash.remote.switch": "تبديل Gateway",
  "web.splash.remote.useThisMac": "استخدام هذا الـ Mac",
  "web.splash.remote.pairAgain": "النسيان والإقران مجددًا",
  "web.splash.remote.forget": "نسيان {host}",
  "web.splash.remote.close": "إخفاء",
  "web.remote.connectedTo": "متصل بـ {host}",
  "web.remote.switch": "تبديل…",
  "web.remote.thisMac": "هذا الـ Mac",
  "web.remote.menuLabel": "Gateway",
  "web.remote.switcherLabel": "متصل بـ {host}. تبديل Gateway.",
  "web.remote.manage": "Gateways…",
  "web.panes.title.terminalOn": "Terminal على {host}",
  "web.panes.terminalRemote": "يعمل Terminal على {host}. ليس لهذه النافذة صدفة (shell) عليه بعد.",
  "web.splash.remote.pinsUnreadable": "تعذّر على Psyche قراءة Gateways المحفوظة.",
  "web.splash.remote.pinsUnreadableReason":
    "الملف الذي يتذكر هوية كل Gateway لا يمكن قراءته، ولن يتصل Psyche بدونه. لم يتغير شيء.",
  "web.browser.remote": "يعمل المتصفح على {host}.",
  "web.browser.remoteHint":
    "تواصل مهام المتصفح العمل في Psyche على {host}، ويجب أن يكون مفتوحًا هناك.",
};
