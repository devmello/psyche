import type { Catalogue } from "../../index.ts";

/** Notices the Gateway authors (ar); merged into `../ar.ts`. */
export const notices: Partial<Catalogue> = {
  "notice.install.failed.title": "لم يكتمل تثبيت تمت الموافقة عليه",
  "notice.install.failed.body":
    "{reason, select, lost {أُعيد تشغيل Psyche قبل موافقتك، لذلك ضاع الاقتراح. اقترحه من جديد.} expired {انتهت صلاحية الاقتراح قبل موافقتك. اقترحه من جديد.} other {تعذّر على Psyche تثبيته. راجع القائمة وحاول مرة أخرى.}}",
  "notice.security.changed.title": "تراجع Psyche عن تغيير أمني أُجري خارج التطبيق",
  "notice.security.changed.body":
    "غيّر برنامج على هذا الـ Mac {count, plural, =1 {سجل أمان واحدًا} other {# من سجلات الأمان}} (الأجهزة أو المفاتيح أو الأذونات أو الإعدادات) دون المرور عبر Psyche{times, plural, =0 {} =1 {} other {، # مرات حتى الآن}}. أعاد Psyche كل شيء كما كان. إن لم تكن أنت من فعل ذلك، فافحص الـ Mac بحثًا عن برامج غير مرغوب فيها.",
  "notice.security.untrusted.title": "لا يستطيع Psyche الوثوق بسجلات الأمان لديه",
  "notice.security.untrusted.body":
    "فشل فحص سجلات الأمان في Psyche، لذلك حُظرت التغييرات الأمنية والأجهزة الجديدة وموافقات Touch ID. راجع أجهزتك، ثم شغّل `psyched security reseal` على الـ Mac (يسري بعد 24 ساعة).",
  "notice.security.firstSeal.title": "أصبح Psyche يفحص سجلات الأمان لديه الآن",
  "notice.security.firstSeal.body":
    "ختم Psyche {devices, plural, =1 {جهازًا مقترنًا واحدًا} other {# أجهزة مقترنة}} وإعدادات الأمان فيه. من الآن، يُلغى أي تغيير يجري خارج Psyche ويظهر هنا. راجع أجهزتك مرة واحدة.",
  "notice.security.resealed.title":
    "{restored, select, yes {خُتمت سجلات الأمان بعد الاستعادة} other {خُتمت سجلات الأمان من جديد}}",
  "notice.security.resealed.body":
    "{restored, select, yes {بدأ Psyche من نسخة احتياطية مستعادة وختم سجلات الأمان كما هي. إن لم تستعد نسخة احتياطية، فراجع أجهزتك.} other {ختم Psyche سجلات الأمان لديه من جديد بعد فترة الانتظار.}}",
  "notice.security.firstAdmin.title": "أنشأ أمر على هذا الـ Mac أول جهاز مسؤول",
  "notice.security.firstAdmin.body":
    "أصبح {device}{key, select, none {} other { (المفتاح {key})}} أول جهاز مسؤول على هذا الـ Mac {via, select, desktop {من تطبيق Psyche} other {عبر `psyched`}}. إن لم تكن أنت من فعل ذلك، فألغِه من الإعدادات ← الأجهزة.",
  "notice.security.recovery.title":
    "{state, select, requested {طلب أمر على هذا الـ Mac تغييرًا أمنيًا} applied {طُبّق تغيير أمني صادر من هذا الـ Mac} cancelled {أُلغي تغيير أمني صادر من هذا الـ Mac} other {تعذّر تطبيق تغيير أمني صادر من هذا الـ Mac}}",
  "notice.security.recovery.body":
    "{op, select, approve {الموافقة على الجهاز {device}{key, select, none {} other { (المفتاح {key})}} بالأذونات {scopes}.} grant {منح {device}{key, select, none {} other { (المفتاح {key})}} الأذونات {scopes}.} presence {إيقاف اشتراط Touch ID ومفتاح المرور للتغييرات الأمنية حتى يُسجَّل مفتاح جديد.} seal {قبول سجلات الأمان الحالية كما هي.} other {تغيير أمني.}}{state, select, requested { سيُطبَّق {when, select, none {بعد 24 ساعة} other {في {when}}} ما لم تلغِه في Psyche.} failed {{reason, select, none {} other { {reason}}}} other {}}",
  "notice.browser.chrome.title": "Psyche يتحكم في Chrome لديك",
  "notice.browser.chrome.body":
    "تستخدم مهمة ملف Chrome الخاص بـ Psyche الذي سجّلت الدخول فيه. عنوان نافذته “Psyche is driving this window”. يُغلق عند انتهاء المهمة، ويمكنك أيضًا إنهاء Chrome.",
  "notice.browser.takeover.title": "يحتاجك Psyche في المتصفح",
  "notice.browser.takeover.body":
    "على {host}، يسأل الوكيل: {reason}. تولَّ التحكم في لوحة المتصفح ثم أعده إليه.",
  "notice.connector.consent.title": "أكمل ربط Google",
  "notice.connector.consent.body":
    "افتح هذا الرابط على الكمبيوتر الذي يعمل عليه Psyche لمنح الوصول: {url}",
  "notice.connector.changed.title": "تغيّر اتصال",
  "notice.connector.changed.body":
    "{reason, select, account_changed {يسجّل موصّل الدخول الآن إلى حساب مختلف. أُوقف العمل المرتبط بالحساب القديم.} disconnected {فُصل موصّل. أُوقف العمل الذي كان يحتاج إليه.} scope_changed {أصبح موصّل للقراءة فقط. أُوقفت الإجراءات المعلّقة عبره.} other {أُلغي وصول موصّل. سجّل الدخول من جديد لمواصلة استخدامه.}}",
  "notice.connector.reconnect.title": "يلزم إعادة الاتصال",
  "notice.connector.reconnect.body": "فقد موصّل إمكانية الوصول ويلزمك تسجيل الدخول من جديد.",
  "notice.attention.paused.title": "مهمة تنتظرك",
  "notice.attention.paused.body":
    "توقفت مؤقتًا قبل {tool} على تطبيق أو موقع حساس إلى أن تعود إلى Psyche.",
  "notice.apiKey.changed.title":
    "{kind, select, brave {{action, select, changed {تم تغيير} other {تمت إزالة}} مفتاح {provider}} other {{action, select, changed {تم تغيير} other {تمت إزالة}} مفتاح API الخاص بـ {provider}}}",
  "notice.apiKey.changed.body":
    '{action, select, changed {التغيير} other {الإزالة}} من {device, select, none {جهاز} other {"{device}" ({platform}{paired, select, none {} other {، اقترن في {paired}}})}}. إن لم تكن أنت من فعل ذلك، فألغِ الجهاز من الإعدادات ← الأجهزة.',
  "notice.approvals.digest.title":
    "{count, plural, =1 {إجراء واحد من الأتمتة ينتظر} other {# إجراءات من الأتمتة تنتظر}}",
  "notice.approvals.digest.body": "افتح الموافقات للموافقة عليها أو رفضها",
  "notice.approvals.resumeMissed.title":
    "{automation, select, none {لم يُنفَّذ إجراء أتمتة تمت الموافقة عليه} other {{automation}: لم يُنفَّذ الإجراء الذي تمت الموافقة عليه}}",
  "notice.approvals.resumeMissed.body":
    "{why, select, expired {انتهت صلاحية الموافقة قبل أن تصل الأتمتة إلى الإجراء، لذا لم يُنفَّذ شيء. إن كانت لا تزال تحتاجه فستطلبه مرة أخرى.} paused {الأتمتة متوقفة مؤقتًا أو أُزيلت، لذا لم تعمل مرة أخرى ولم يُنفَّذ شيء. إن كانت لا تزال تحتاجه فستطلبه مرة أخرى.} restart {أُعيد تشغيل Psyche قبل أن تعمل الأتمتة مرة أخرى، لذا لم يُنفَّذ شيء. إن كانت لا تزال تحتاجه فستطلبه مرة أخرى.} restart_kept {أُعيد تشغيل Psyche قبل أن تعمل الأتمتة مرة أخرى. يبقى الإذن الذي منحته، لذا سيفعل تشغيلها التالي هذا دون أن يسأل. لسحبه، ألغِه من الأذونات الدائمة في الموافقات.} failed {أعادت الأتمتة تنفيذ الإجراء، لكنه فشل. راجع النشاط لمعرفة ما حدث. إن كانت لا تزال تحتاجه فستطلبه مرة أخرى.} failed_kept {أعادت الأتمتة تنفيذ الإجراء، لكنه فشل. راجع النشاط لمعرفة ما حدث. يبقى الإذن الذي منحته، لذا سيحاول تشغيلها التالي مرة أخرى دون أن يسأل. لسحبه، ألغِه من الأذونات الدائمة في الموافقات.} unknown {أعادت الأتمتة تنفيذ الإجراء، لكن Psyche لا يستطيع معرفة ما إذا كان قد نجح. راجع النشاط لتتأكد.} not_reached_kept {عملت الأتمتة مرة أخرى لكنها لم تصل إلى الإجراء نفسه، لذا لم يُنفَّذ شيء. يبقى الإذن الذي منحته، لذا سيفعل تشغيلها التالي هذا دون أن يسأل. لسحبه، ألغِه من الأذونات الدائمة في الموافقات.} other {عملت الأتمتة مرة أخرى لكنها لم تصل إلى الإجراء نفسه، لذا لم يُنفَّذ شيء. إن كانت لا تزال تحتاجه فستطلبه مرة أخرى.}}",
  "notice.specialist.result.title":
    "{outcome, select, done {{who} أنهى {title}} partial {توقف {who} مبكرًا في {title}} cancelled {تم إيقاف {who} في {title}} other {تعذّر على {who} إنهاء {title}}}",
  "notice.specialist.result.body":
    "{outcome, select, done {تم} partial {جزئي} cancelled {أُلغي} other {فشل}}{findings, plural, =0 {} one { · ملاحظة واحدة} two { · ملاحظتان} few { · # ملاحظات} many { · # ملاحظة} other { · # ملاحظة}}{cost, select, none {} other { · {cost}}} · {minutes, plural, =0 {أقل من دقيقة} other {# د}}",
  "notice.mcp.changed.title": "خادم MCP {server} غيّر أدواته",
  "notice.mcp.suspicious.title": "خادم MCP {server} فيه أوصاف أدوات مريبة",
  "notice.mcp.review.body": "راجعها قبل استخدام هذا الخادم: {details}",
  "notice.security.tightened.title":
    "تم تشديد إعدادات الأمان من {device, select, none {أحد الأجهزة} other {{device}}}",
  "notice.security.tightened.body":
    "هذا قلّل فقط ما يُسمح لـ Psyche بفعله، لذلك لم تكن هناك حاجة إلى موافقة. إن لم تكن أنت، فألغِ ربط الجهاز من الإعدادات ← الأجهزة.",
  "notice.codeRun.held.title": "احتجز Psyche إعدادات تشغيل من تنفيذ كود في {repo}",
  "notice.codeRun.held.body":
    "أنشأ أمر في بيئة العزل {paths}. قد تشغّل التطبيقات أو أمرك التالي كودًا منها، لذلك نقلها Psyche جانبًا دون حذفها. إن كنت أنت أو أدواتك من أنشأها، فاضغط «الإبقاء عليها».",
  "notice.codeRun.changed.title": "تغيّرت إعدادات التشغيل أثناء تنفيذ كود في {repo}",
  "notice.codeRun.changed.body":
    "تغيّر {paths} بينما كان أمر يعمل في بيئة العزل. إن لم يكن ذلك منك أو من محررك، فراجعه قبل فتح المجلد.",
  "notice.codeRun.partial.title": "{repo} أكبر من أن يُفحص بالكامل",
  "notice.codeRun.partial.body":
    "فحص Psyche المجلدات العليا فقط بحثًا عن إعدادات تشغيل تنشئها عمليات تنفيذ الكود.",
  "notice.codeRun.recreated.title": "أُعيد إنشاء بيئة العزل الخاصة بـ {repo}",
  "notice.codeRun.recreated.body":
    "تغيّرت مجلداتها المخصصة للقراءة فقط، لذا توقفت الخوادم العاملة واختفى ما ثُبّت خارج المستودع. أعد تشغيل ما تحتاجه.",
  "notice.action.keepIt": "الإبقاء عليها",
  "notice.codeRun.incident.title": "احتجز Psyche شيئًا قد لا يكون من تنفيذ كود في {repo}",
  "notice.codeRun.incident.body":
    "أثناء نقل {paths} جانبًا تغيّر مجلد في الطريق، لذا قد يكون ما نُقل من مكان آخر. هو محفوظ في {place}. راجعه قبل أن تضغط «الإبقاء عليها»، الذي يضعه في {paths} داخل {repo}.",
  "notice.codeRun.unmoved.title": "إعدادات تشغيل من تنفيذ كود في {repo} ما زالت في مكانها",
  "notice.codeRun.unmoved.body":
    "أنشأ أمر في بيئة العزل {paths}، ولم يتمكن Psyche من نقلها جانبًا، فهي غير محتجزة. قد تشغّل التطبيقات أو أمرك التالي كودًا منها. احذفها قبل أن تفتح المجلد أو تشغّل أي شيء فيه. لا تغيّر أذوناتها لتنظر داخلها أولًا، فقد يتيح ذلك تشغيلها.",
  "notice.codeRun.unchecked.title": "تعذّر على Psyche فحص جزء من {repo} بعد تنفيذ كود",
  "notice.codeRun.unchecked.body":
    "تغيّر {paths} بينما كان Psyche يفحصه بعد تشغيل أمر في بيئة العزل، لذلك لم يُفحص أي شيء بداخله بحثًا عن إعدادات تشغيل. إذا لم تغيّره أنت أو أدواتك، فانظر فيه قبل أن تفتح المجلد أو تشغّل أي شيء فيه.",
  "notice.machine.added.title": "تمت إضافة {name} كجهاز كمبيوتر يمكن لـ Psyche استخدامه",
  "notice.machine.added.body":
    "يمكن لـ Psyche استخدام شاشته وتطبيقاته وطرفيته وملفاته، وكل إجراء هناك يطلب موافقتك أولاً. إن لم تكن أنت من أضافه، فأزِله من الإعدادات ← الأجهزة.",
  "notice.machine.removed.title": "أزال {name} نفسه",
  "notice.machine.removed.body":
    "كان جهاز كمبيوتر يمكن لـ Psyche استخدامه. لن يستخدمه Psyche مجدداً ما لم تضفه من جديد.",
  "notice.machine.scanIncomplete.title": "تعذّر إكمال فحص {folder} على {name} بعد أمر",
  "notice.machine.scanIncomplete.body":
    "ربما لم تُنقل المستودعات أو ملفات التشغيل الجديدة هناك جانباً. افحصه بحثاً عن مجلدات .git أو .vscode جديدة قبل فتحه في محرر أو تشغيل git فيه. لن تتمكن الأوامر من الكتابة هناك مرة أخرى حتى يُعاد تشغيل Psyche على {name}.",
  "notice.machine.offline.title": "انقطع اتصال {name}",
  "notice.machine.offline.body":
    "توجد مهمة تنتظر استخدامه، وستتابع عندما يعود {name}. يمكنك أيضاً إلغاء المهمة.",
  "notice.automation.needsApproval.title": "{title} ينتظر موافقتك",
  "notice.automation.needsApproval.body":
    "توقف لأن الموافقة انتهت صلاحيتها. افتح الموافقات لترى ما يحتاجه، ثم شغّله مرة أخرى.",
  "notice.automation.interrupted.title": "تمت مقاطعة {title}",
  "notice.automation.interrupted.body":
    "أُعيد تشغيل Psyche أثناء تشغيله وربما أنجز جزءًا منه. تحقق من النتيجة، ثم شغّله مرة أخرى إن لزم.",
};
