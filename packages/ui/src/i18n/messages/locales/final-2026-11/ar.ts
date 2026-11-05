import type { Catalogue } from "../../index.ts";

/** Signed connector bundles and teach-by-showing in Mac apps (ar); merged into `../ar.ts`. */
export const final202611: Partial<Catalogue> = {
  "settings.connectorBundle.title": "الموصّل المشترَك {name}",
  "settings.connectorBundle.intro":
    "شارك أحدهم هذا الموصّل كملف. لم يُثبَّت شيء بعد. تحقّق ممن صنعه وما الذي يطلبه، ثم قرّر.",
  "settings.connectorBundle.update": "هذا تحديث للموصّل الذي لديك.",
  "settings.connectorBundle.signer.title": "من صنعه",
  "settings.connectorBundle.signer.unsigned": "هذا الملف غير موقَّع، فلا توجد طريقة لمعرفة من صنعه.",
  "settings.connectorBundle.signer.dropped": "الإصدار المثبَّت كان موقَّعًا. أما هذا فلا.",
  "settings.connectorBundle.signer.new": "وقّعه {name}. لم ترَ هذا المفتاح من قبل.",
  "settings.connectorBundle.signer.seen": "وقّعه {name} بمفتاح رأيته من قبل لكنك لم تثق به.",
  "settings.connectorBundle.signer.trusted": "وقّعه {name}، مؤلف تثق به.",
  "settings.connectorBundle.signer.own": "وقّعته أنت.",
  "settings.connectorBundle.signer.changed":
    "وقّعه {name}، لكن ليس بالمفتاح الذي رُئي من قبل. تأكد أنه الشخص نفسه.",
  "settings.connectorBundle.signer.impersonates": "وُقّع باسم يشبه اسمك، لكن بمفتاح ليس مفتاحك.",
  "settings.connectorBundle.signer.nameChanged":
    "مفتاح تثق به يوقّع الآن باسم لم يستخدمه من قبل: {name}.",
  "settings.connectorBundle.signer.revoked": "وقّعه مفتاح كنت قد أبطلته.",
  "settings.connectorBundle.signer.rotated":
    "وقّعه {name}: المؤلف نفسه بمفتاح جديد (وقّعه المفتاح القديم). لا يُوثَق بالمفتاح الجديد حتى تثق به أنت.",
  "settings.connectorBundle.signer.claim":
    "الاسم ادعاء من المؤلف نفسه. المفتاح وحده هو ما يحدد هويته.",
  "settings.connectorBundle.signer.key": "مفتاح المؤلف",
  "settings.connectorBundle.signer.trust": "الوثوق بـ {name} كمؤلف",
  "settings.connectorBundle.signer.trustHint":
    "يغيّر هذا التسمية والتحذيرات في الملفات اللاحقة فقط. ولا يتخطى هذه البطاقة أبدًا.",
  "settings.connectorBundle.command": "الأمر الذي ينفّذه",
  "settings.connectorBundle.commandHint":
    "البرنامج أولًا، ثم كل وسيط في سطر مستقل. لا يُنفَّذ عبر الصدفة (shell).",
  "settings.connectorBundle.network": "الشبكة التي يطلبها",
  "settings.connectorBundle.noNetwork": "بلا شبكة",
  "settings.connectorBundle.networkHint":
    "البيئة المعزولة وحدها قادرة على فرض هذا. القائمة هي ما يقوله المؤلف.",
  "settings.connectorBundle.env": "المتغيرات التي يقرؤها",
  "settings.connectorBundle.noEnv": "لا شيء",
  "settings.connectorBundle.envHint": "الأسماء فقط. تعطيها قيمًا بعد التثبيت.",
  "settings.connectorBundle.secrets": "الأسرار التي يحتاج إليها",
  "settings.connectorBundle.noSecrets": "لا شيء",
  "settings.connectorBundle.secretsHint":
    "الأسماء فقط. لا يحمل الملف أي سر. بعد التثبيت تعطي كل سر قيمة، وتُحفظ في خزنتك.",
  "settings.connectorBundle.tools": "الأدوات التي يقول المؤلف إنه يعرضها",
  "settings.connectorBundle.toolsCount":
    "{n, plural, zero {لا أدوات} one {أداة واحدة} two {أداتان} few {# أدوات} many {# أداة} other {# أداة}}",
  "settings.connectorBundle.toolsHint":
    "يشغّله Psyche في البيئة المعزولة ويسرد ما يعرضه فعلًا. وتلك الأدوات هي المعتمدة.",
  "settings.connectorBundle.toolsUndeclared": "سرد الخادم أدوات لم يعلنها الملف: {names}",
  "settings.connectorBundle.toolsMissing": "أعلن الملف أدوات لم يسردها الخادم: {names}",
  "settings.connectorBundle.files": "السكربتات المرفقة به ({n})",
  "settings.connectorBundle.file": "{path} · {bytes} B",
  "settings.connectorBundle.fileBinary": "ليس نصًا، لذلك لا يمكن عرضه هنا.",
  "settings.connectorBundle.findings": "ما وجدته الفحوص",
  "settings.connectorBundle.finding.high": "يمنع التثبيت: {message}",
  "settings.connectorBundle.finding.warn": "يلزم التحقق: {message}",
  "settings.connectorBundle.finding.info": "{message}",
  "settings.connectorBundle.sandbox.srt":
    "يجري التشغيل الأول داخل البيئة المعزولة. يشغّله Psyche هناك لسرد أدواته، ويظل يعمل هناك.",
  "settings.connectorBundle.sandbox.container":
    "يجري التشغيل الأول داخل حاوية معزولة. يشغّله Psyche هناك لسرد أدواته، ويظل يعمل هناك.",
  "settings.connectorBundle.sandbox.none":
    "لا توجد في جهاز Mac هذا بيئة معزولة لموصّلات الأوامر، ولا يشغّل Psyche أيًّا منها خارجها. لا يمكن تثبيت هذا الموصّل هنا. لم يُشغَّل أو يُحفظ أي شيء.",
  "settings.connectorBundle.blocker.scan": "وجدت الفحوص ما يمنع تثبيته. لم يُشغَّل أو يُحفظ أي شيء.",
  "settings.connectorBundle.blocker.probe_failed":
    "تعذّر تشغيله في التشغيل الأول، دون شبكة ودون أسرار. لم يُحفظ أي شيء.",
  "settings.connectorBundle.signer.ownRetired":
    "وُقّع بمفتاح كان لك واستبدلته. لم يعد يُعامل على أنه مفتاحك.",
  "settings.connectorBundle.signer.retired":
    "وقّعه {name} بمفتاح استُبدل في تدوير مفاتيح رأيته. أي ملف جديد منه مشبوه.",
  "settings.connectorBundle.carry.kept": "القيم التي أعطيتها وستبقى: {names}",
  "settings.connectorBundle.carry.cleared":
    "القيم التي أعطيتها ولن تُنقل، لأن الموقِّع أو الأمر تغيّر. أدخلها من جديد: {names}",
  "settings.connectorBundle.carry.vault":
    "الأسرار التي خزّنتها سابقًا تبقى في خزنتك لكنها لا تُسلَّم لهذا الإصدار.",
  "settings.connectorBundle.reset.title": "إذا كان سجل الموصّلات المشترَكة تالفًا",
  "settings.connectorBundle.reset.hint":
    "تظل الموصّلات التي جاءت من ملف متوقفة ما دام سجلها غير قابل للقراءة. يعزل هذا السجل التالف جانبًا (ويستعيد آخر نسخة سليمة إن وُجدت)؛ وتبقى تلك الموصّلات متوقفة حتى تزيلها أو تستوردها من جديد.",
  "settings.connectorBundle.reset.go": "إعادة ضبط السجل…",
  "settings.connectorBundle.reset.confirm": "نعم، أعد الضبط",
  "settings.connectorBundle.reset.done":
    "أُعيد ضبط السجل. {restored, select, true {استُعيدت آخر نسخة سليمة.} other {يبدأ فارغًا.}}",
  "settings.connectorBundle.reset.failed": "تعذّرت إعادة ضبط السجل: {reason}",
  "settings.connectorBundle.hash": "معرّف الحزمة",
  "settings.connectorBundle.close": "إغلاق",
  "settings.connectorBundle.widened.title": "يطلب أكثر من الإصدار الذي لديك",
  "settings.connectorBundle.widened.hint":
    "الموافقة على هذه البطاقة تمنحه هذه الأمور. بطاقة الإصدار الأضيق لم تكن لتشملها.",
  "settings.connectorBundle.widened.command": "أمر مختلف",
  "settings.connectorBundle.widened.commandValue": "الآن {now}. قبل ذلك: {before}",
  "settings.connectorBundle.widened.env": "متغيرات أكثر",
  "settings.connectorBundle.widened.secrets": "أسرار أكثر",
  "settings.connectorBundle.widened.network": "شبكة أكثر",
  "settings.connectorBundle.widened.tools": "أدوات أكثر، أو أدوات تستطيع فعل المزيد",
  "settings.connectorBundle.widened.payload": "سكربتات مختلفة",
  "settings.connectorBundle.widened.payloadValue": "تغيّرت الملفات المرفقة",
  "settings.connectorBundle.diff": "ما الذي تغيّر",
  "settings.connectorBundle.noChanges": "لم يتغيّر شيء آخر.",
  "settings.connectorBundle.import.title": "الموصّلات المشترَكة",
  "settings.connectorBundle.import.hint":
    "استورد موصّلًا أرسله إليك أحدهم كملف أو رابط. سترى كل ما يطلبه قبل تثبيت أي شيء.",
  "settings.connectorBundle.import.file": "استيراد ملف موصّل",
  "settings.connectorBundle.import.linkLabel": "أو الصق رابطًا إلى أحدها",
  "settings.connectorBundle.import.linkPlaceholder": "https://example.com/notes.psyche-connector",
  "settings.connectorBundle.import.review": "مراجعة",
  "settings.connectorBundle.import.checking": "جارٍ الفحص…",
  "settings.connectorBundle.import.failed": "تعذّر استيراد الموصّل: {reason}",
  "settings.connectorBundle.import.tooBig": "هذا الملف أكبر من أن يكون موصّلًا.",
  "settings.connectorBundle.import.denied": "لم يُثبَّت {name}.",
  "settings.connectorBundle.import.lapsed":
    "{expired, select, true {انتهت صلاحية بطاقة {name}.} other {لم تعد بطاقة {name} سارية.}} استورده من جديد لمراجعته.",
  "settings.connectorBundle.import.added":
    "أُضيف {name}. أعطِه أدناه الأسرار التي يحتاج إليها ليتمكن من استخدامها.",
  "settings.connectorBundle.import.addedNoSecrets": "أُضيف {name}.",
  "settings.connectorBundle.import.addFailed": "تعذّرت إضافة {name}: {reason}",
  "settings.connectorBundle.import.secretsTitle": "أسرار {name}",
  "settings.connectorBundle.share.title": "مشاركة هذا الموصّل",
  "settings.connectorBundle.share.hint":
    "ينشئ ملفًا موقَّعًا فيه الأمر وأسماء متغيراته وأسراره والشبكة التي يصل إليها وأدواته. لا تُضمَّن فيه أي قيمة أبدًا. وتؤكد أولًا ما سيدخل فيه.",
  "settings.connectorBundle.share.go": "مشاركة…",
  "settings.connectorBundle.share.nameLabel": "اسمك على الموصّلات المشترَكة",
  "settings.connectorBundle.share.nameHint":
    "كل من يستورد ملفًا منك يرى هذا الاسم. يُطلب مرة واحدة؛ ويُنشأ مفتاح توقيعك الآن.",
  "settings.connectorBundle.share.make": "إنشاء الملف",
  "settings.connectorBundle.share.label": "مشاركة {name}",
  "settings.connectorBundle.share.done":
    "حُفظ {file}، موقَّعًا باسم {author}. فيه أسماء فقط: لا قيمة لأي متغير أو سر.",
  "settings.connectorBundle.share.failed": "تعذّرت مشاركة الموصّل: {reason}",
  "settings.connectorBundle.share.unavailable":
    "لا يستطيع توقيع الموصّل إلا Psyche على جهاز Mac الذي يشغّله.",
  "settings.skills.signer.ownRetired": "وُقّع بمفتاح كان لك واستبدلته. لم يعد يُعامل على أنه مفتاحك.",
  "settings.skills.signer.retired":
    "وقّعه {name} بمفتاح استُبدل في تدوير مفاتيح رأيته. أي ملف جديد منه مشبوه.",
  "settings.skills.signer.rotated":
    "وقّعه {name}: المؤلف نفسه بمفتاح جديد (وقّعه المفتاح القديم). لا يُوثَق بالمفتاح الجديد حتى تثق به أنت.",
  "settings.skills.author.state.seen": "مرئي، غير موثوق",
  "settings.skills.author.state.trusted": "موثوق",
  "settings.skills.author.state.revoked": "مُبطَل",
  "settings.skills.keys.title": "مفتاح المؤلف الخاص بك والإشعارات",
  "settings.skills.keys.hint":
    "المفتاح الذي يوقّع المهارات والموصّلات التي تشاركها. يمكنك استبداله، ونشر إشعار حين لا ينبغي الوثوق بمفتاح أو ملف بعد الآن.",
  "settings.skills.keys.none":
    "لم توقّع أي شيء بعد. يُنشأ مفتاحك عند أول مرة تشارك فيها مهارة أو موصّلًا.",
  "settings.skills.keys.own": "التوقيع باسم {name}",
  "settings.skills.keys.fingerprint": "المفتاح",
  "settings.skills.keys.rotate": "استبدال مفتاحي…",
  "settings.skills.keys.rotateHint":
    "ينشئ مفتاحًا جديدًا بالاسم نفسه. يوقّع المفتاح القديم بيانًا يسمّي الجديد، فيرى من وثقوا بك المؤلف نفسه بمفتاح جديد. ومع ذلك عليهم أن يثقوا به بأنفسهم. وتؤكد أولًا.",
  "settings.skills.keys.rotateLabel": "استبدال مفتاح المؤلف الخاص بك",
  "settings.skills.keys.rotated": "استُبدل مفتاحك. المفتاح الجديد هو {key}.",
  "settings.skills.keys.rotateFailed": "تعذّر استبدال المفتاح: {reason}",
  "settings.skills.keys.notice.title": "نشر إشعار",
  "settings.skills.keys.notice.hint":
    "الإشعار ملف صغير موقَّع. أرسله أو استضفه، ويستطيع كل من عرف مفتاحك استيراده لحظر مفتاح أو ملف واحد.",
  "settings.skills.keys.notice.kindKey": "مفتاحي (الحالي)",
  "settings.skills.keys.notice.kindBundle": "ملف واحد شاركته، بمعرّف حزمته",
  "settings.skills.keys.notice.kind": "ما المشكلة",
  "settings.skills.keys.notice.hash": "معرّف الحزمة (sha256:…)",
  "settings.skills.keys.notice.reason": "السبب (يراه كل من يستورده)",
  "settings.skills.keys.notice.make": "إنشاء الإشعار",
  "settings.skills.keys.notice.label": "توقيع إشعار إبطال",
  "settings.skills.keys.notice.done": "حُفظ {file}. انشره بالطريقة التي تفضّلها.",
  "settings.skills.keys.notice.failed": "تعذّر إنشاء الإشعار: {reason}",
  "settings.skills.keys.import.title": "استيراد إشعار إبطال",
  "settings.skills.keys.import.hint":
    "لا يُطبَّق إلا إذا وقّعه مؤلف سبق أن عرفته. يستطيع الحظر فقط: ولا يمنح الثقة لأي شيء أبدًا.",
  "settings.skills.keys.import.file": "استيراد ملف إشعار",
  "settings.skills.keys.import.linkLabel": "أو الصق رابطًا",
  "settings.skills.keys.import.linkPlaceholder": "https://example.com/revoke.psyche-notice",
  "settings.skills.keys.import.go": "استيراد",
  "settings.skills.keys.import.key": "حُظر المفتاح {key}. السبب المذكور: {reason}",
  "settings.skills.keys.import.bundle": "حُظر الملف {hash}. السبب المذكور: {reason}",
  "settings.skills.keys.import.previewKey":
    "سيُبطل هذا المفتاح {key}{names, select, none {} other { (المعروف باسم {names})}}. السبب الذي ذكره الموقِّع: {reason}",
  "settings.skills.keys.import.previewBundle":
    "سيحظر هذا الملف {hash}. السبب الذي ذكره الموقِّع: {reason}",
  "settings.skills.keys.import.already": "هو ساري المفعول بالفعل.",
  "settings.skills.keys.import.apply": "تطبيقه",
  "settings.skills.keys.import.signedBy": "وقّعه {name}.",
  "settings.skills.keys.import.failed": "تعذّر استخدام الإشعار: {reason}",
  "web.teach.app.record": "التسجيل في تطبيق",
  "web.teach.app.recordHint": "أرِ Psyche كيف تنجز أمرًا في تطبيق Mac سمحت به من قبل",
  "web.teach.app.pickTitle": "التسجيل في أي تطبيق؟",
  "web.teach.app.pickLabel": "التطبيق",
  "web.teach.app.pickHint":
    "تظهر هنا التطبيقات التي سمحت لها باستخدام الكمبيوتر فقط. افتح التطبيق أولًا. لا تُسجَّل كلمات المرور وأرقام البطاقات والرموز أبدًا، ولا نوافذ Psyche نفسه ولا مطالبات تسجيل الدخول والأمان.",
  "web.teach.app.none":
    "لا يوجد تطبيق جاهز للتسجيل. فعّل استخدام الكمبيوتر في الإعدادات وامنح تطبيقًا مستوى النقر أو التفاعل أولًا.",
  "web.teach.app.start": "بدء التسجيل",
  "web.teach.app.cancelPick": "ليس الآن",
  "web.teach.app.startFailed":
    "تعذّر على Psyche بدء تسجيل ذلك التطبيق. افتحه أولًا، وتأكد أن لدى Psyche إذن تسهيلات الاستخدام.",
  "web.teach.app.bar.title": "جارٍ تسجيل {app}",
  "web.teach.app.bar.body":
    "يدوّن Psyche نقراتك واختياراتك من القوائم وما تكتبه في {app} فقط. لا تُسجَّل الحقول الآمنة أبدًا، ولا تُلتقط لقطات شاشة، ولا يغادر شيء هذا الـ Mac حتى تحفظ. ويوجد في شريط القوائم أيضًا زر إيقاف.",
  "web.teach.app.bar.endedLimit": "توقّف التسجيل عند حد 200 خطوة. راجع ما التقطه.",
  "web.teach.app.bar.endedTimeout": "توقّف التسجيل عند بلوغ حده الزمني. راجع ما التقطه.",
  "web.teach.app.bar.endedInterrupted": "انتهى التسجيل مبكرًا لأن التطبيق أُغلق. راجع ما التقطه.",
  "web.teach.app.stopFailed": "تعذّر على Psyche إنهاء التسجيل.",
  "web.teach.app.skipped":
    "{count, plural, zero {لم يُستبعد أي عنصر.} one {استُبعد عنصر واحد: حقل آمن، أو عنصر تحكم بلا اسم يمكن العثور عليه به.} two {استُبعد عنصران: حقلان آمنان، أو عنصرا تحكم بلا اسم يمكن العثور عليهما به.} few {استُبعدت # عناصر: حقول آمنة، أو عناصر تحكم بلا أسماء يمكن العثور عليها بها.} many {استُبعد # عنصرًا: حقول آمنة، أو عناصر تحكم بلا أسماء يمكن العثور عليها بها.} other {استُبعد # عنصر: حقول آمنة، أو عناصر تحكم بلا أسماء يمكن العثور عليها بها.}}",
  "web.teach.app.privacy":
    "النص في هذه الخطوات مأخوذ من نوافذ التطبيق وقوائمه. يُعامل على أنه بيانات، لا على أنه تعليمات أبدًا. وعند الحفظ يُطلب منك الموافقة على المهارة قبل أن تتمكن من العمل.",
  "web.teach.app.sensitive": "لم يُسجَّل. سيطلب منك Psyche أن تنفّذ هذا الجزء بنفسك.",
  "web.teach.app.runHint":
    "يملأ مربع الرسالة بالمهارة. اضغط إرسال وراقب التطبيق: كل نقرة وكل إدخال يطلب الموافقة كالمعتاد، ويتوقف ويسأل إذا لم يجد شيئًا في مكانه.",
  "web.teach.step.app.click": "في {app}، انقر على «{name}»",
  "web.teach.step.app.clickRole": "في {app}، انقر على {role}",
  "web.teach.step.app.menu": "في {app}، اختر {path}",
  "web.teach.step.app.type": "في {app}، اكتب في «{name}»",
  "web.teach.step.app.typeKept": "في {app}، اكتب {value} في «{name}»",
  "web.teach.step.app.typeInput": "في {app}، اكتب {input} في «{name}»",
  "web.teach.step.app.typeAsk": "في {app}، اكتب في «{name}» ما تحدده",
  "web.teach.step.app.typeSensitive": "في {app}، تكتب أنت بنفسك في «{name}»",
  "app.integrity.title": "تم تغيير ملفات Psyche",
  "app.integrity.detail":
    "لم تعد هذه النسخة من Psyche تطابق التوقيع الذي صدرت به، لذا قد يكون شيء ما قد عدّلها. إلى أن تعيد تثبيتها من التنزيل الرسمي، ستبقي Psyche ميزات الميكروفون والشاشة وأحداث Apple وجهات الاتصال والتقويم متوقفة.",
  "app.integrity.blocked": "متوقف: تم تعديل هذه النسخة من Psyche. أعد تثبيتها من التنزيل الرسمي.",
  "app.integrity.ok": "حسنًا",
};
