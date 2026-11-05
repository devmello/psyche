import type { MessageId } from "../index.ts";

/**
 * Translations of the Linux variants (`./linux.ts`), by message locale. A message missing here
 * shows the English variant on Linux, never the Mac wording. Terms: "this computer", "your
 * password" (the account password, asked through the system dialog), "Files", "Settings", the
 * system tray and the system keyring.
 */
export const LINUX_LOCALES: Readonly<Record<string, Readonly<Partial<Record<MessageId, string>>>>> =
  {
    ar: {
      "settings.devices.nodeKind.hostHelper": "مساعد Linux",
      "settings.links.description":
        "المكان الذي يُفتح فيه رابط في رسالة أو بطاقة أو عنصر. النقر مع Ctrl يستخدم دائمًا المتصفح الافتراضي.",
      "errors.presence_required": "أكّد أنك أنت عبر كلمة المرور أو مفتاح مرور أولًا.",
      "chat.toolbar.keySheet": "Ctrl+Shift+A",
      "chat.toolbar.keyModel": "Ctrl+Shift+I",
      "chat.toolbar.keyView": "Ctrl+O",
      "chat.approval.keysHint": "Ctrl+Enter {allows} · Ctrl+D {denies}",
      "blocks.details.runsOnHost": "على الكمبيوتر الخاص بك، خارج البيئة المعزولة",
      "blocks.details.runsSandboxed":
        "على الكمبيوتر الخاص بك، داخل البيئة المعزولة: لا يستطيع قراءة خزنة Psyche أو مفاتيح SSH أو سلسلة مفاتيح النظام أو ملفات تعريف المتصفح",
      "blocks.details.runsNoSandbox":
        "على الكمبيوتر الخاص بك، والبيئة المعزولة غير مُعدّة ({reason})",
      "blocks.permission.need.capability": "فعّل «تشغيل الأوامر على هذا الكمبيوتر»",
      "blocks.permission.need.macos_access": "امنح {connector} حق الوصول في الإعدادات",
      "blocks.permission.openSystemSettings": "فتح الإعدادات",
      "blocks.approval.answerOnHost":
        "أجب على {host}، أو أعدّ الموافقات بكلمة المرور لهذا الكمبيوتر في الإعدادات ← الأجهزة.",
      "blocks.approval.needsAuth": "تحتاج الموافقة إلى كلمة المرور أو مفتاح مرور.",
      "blocks.approval.touchIdFailed": "فشل التحقق من كلمة المرور: {reason}. حاول مجددًا.",
      "blocks.approval.touchIdFailedNoReason": "فشل التحقق من كلمة المرور. حاول مجددًا.",
      "blocks.approval.touchId.helperOffline":
        "مساعد Linux لا يعمل، لذا لا تستطيع كلمة المرور التأكيد هنا.",
      "blocks.approval.touchId.noKey":
        "لم تُعدّ الموافقات بكلمة المرور على هذا الكمبيوتر بعد. أعدّها في الإعدادات ← الأجهزة، حيث يمكنك فحص المفتاح أولًا.",
      "blocks.approval.touchId.invalidated":
        "تغيّر إعداد كلمة المرور منذ إعداد مفتاح هذا الكمبيوتر، لذا لا يستطيع تأكيد الموافقات. أعدّه مجددًا في الإعدادات ← الأجهزة.",
      "blocks.approval.touchId.noUnsandboxed":
        "لا يمكن الموافقة على تشغيل أمر بلا بيئة معزولة باستخدام كلمة المرور من هذه النافذة. أعدّ البيئة المعزولة بدلًا من ذلك",
      "blocks.approval.touchId.onceOnly":
        "موافقات كلمة المرور من هذه النافذة صالحة لمرة واحدة فقط.",
      "blocks.approval.status.allowedOnceTouchId":
        "تم السماح مرة واحدة (موافقات كلمة المرور من هذه النافذة صالحة لمرة واحدة فقط)",
      "blocks.approval.touchId.keyUnavailable":
        "لا يستطيع هذا الإصدار من مساعد Linux حفظ مفتاح موافقة، لذا لا يمكن الموافقة على البطاقات التي تحتاج إلى كلمة المرور على هذا الكمبيوتر.",
      "blocks.approval.touchId.cancelled": "أُلغيت مطالبة كلمة المرور، لذا لم تتم الموافقة على شيء",
      "shell.shortcut.pushToTalkKeys": "اضغط مطوّلًا على Ctrl الأيمن",
      "settings.shared.needsPresence":
        "يحتاج تغيير «{label}» إلى موافقتك عبر كلمة المرور أو مفتاح مرور. وافق عليه في الإعدادات أو في إشعار Psyche، ثم غيّره مرة أخرى.",
      "settings.page.permissions.description":
        "ما يجوز لـ {persona} فعله على هذا الكمبيوتر دون سؤال، وأين يتوقف دائمًا ليسألك.",
      "settings.page.data.description":
        "ما يبقى على هذا الكمبيوتر ومدة بقائه والتصدير والنسخ الاحتياطية والبدء من جديد.",
      "settings.essentials.model.noneHint":
        "يحتاج {persona} إلى نموذج قبل أن يستطيع الإجابة. أضف مفتاحًا، أو استخدم نموذجًا على هذا الكمبيوتر.",
      "settings.essentials.read.hint":
        "متوقف حتى تفعّل أحدها. يُفهرَس ما يقرؤه على هذا الكمبيوتر ليجد لك الأشياء، وتتعلم منه الذاكرة أيضًا ما لم تلغِ ذلك في الذاكرة ← المصادر.",
      "settings.searchModel.apple.notOnThisMac": "متاح على macOS",
      "settings.macHelper.paired.text":
        "يشغّل استخدام الكمبيوتر وسياق الشاشة والإملاء والموافقات بكلمة المرور والإشعارات على هذا الكمبيوتر.",
      "settings.macHelper.unbundled.text": "هذا الإصدار من Psyche لا يتضمن مساعد Linux.",
      "settings.key.appearance.showInDock": "الإظهار في شريط المهام عند عدم فتح أي نافذة",
      "settings.semanticSearch.encrypt.pending": "بانتظار أن يفتح مساعد Linux الفهرس المشفّر",
      "settings.semanticSearch.rerankHint":
        "يضع نموذج سحابي صغير أفضل النتائج أولًا. تغادر أعلى 20 مقتطفًا هذا الكمبيوتر. متوقف افتراضيًا.",
      "settings.key.vm.enabled": "استخدام كمبيوتر معزول للمهام",
      "settings.key.vm.resetPerTask": "كمبيوتر جديد لكل مهمة",
      "settings.credentials.backend.psyche": "خزنة Psyche ‏(كلمة المرور)",
      "settings.credentials.backend.keychain": "سلسلة مفاتيح النظام",
      "settings.credentials.backendIn.keychain": "في سلسلة مفاتيح النظام",
      "settings.credentials.err.lockedChange":
        "الخزنة مقفلة. افتحها بكلمة المرور، ثم {verb, select, delete {احذف} other {غيّر}} {name} مرة أخرى.",
      "settings.credentials.err.lockedImport":
        "الخزنة مقفلة. افتحها بكلمة المرور، ثم استورد مرة أخرى.",
      "settings.credentials.slot.keychain": "سلسلة مفاتيح النظام (كلمة المرور)",
      "settings.credentials.slot.safeStorage": "تخزين التطبيقات على هذا الكمبيوتر",
      "settings.credentials.slot.keyFile": "ملف مفتاح على هذا الكمبيوتر",
      "settings.credentials.moveToKeychain": "النقل إلى سلسلة مفاتيح النظام",
      "settings.credentials.keyFileExplainer":
        "المفتاح الذي يفتح خزنتك هو ملف لا يمكن إلا لحسابك قراءته. يحتاج نقله إلى سلسلة مفاتيح النظام إلى مساعد Linux؛ ومساعد هذا الإصدار غير متاح.",
      "settings.credentials.link.err.locked":
        "الخزنة مقفلة. افتحها بكلمة المرور، ثم اربط {name} مرة أخرى.",
      "settings.approval.presenceUnavailable":
        "لا تستطيع هذه النافذة التأكد من أنك أنت. وافق على التغيير في تطبيق Psyche على الكمبيوتر الخاص بك (كلمة المرور)، أو من جهاز لديه مفتاح مرور. لن يتغير شيء حتى ذلك الحين.",
      "settings.approval.promptDetail":
        "تحتاج إعدادات الأمن إلى كلمة المرور أو مفتاح مرور. وافق هنا أو في إشعار Psyche؛ يُحفظ الإعداد فور الموافقة.",
      "settings.approval.presenceInvalid":
        "لم تؤكد كلمة المرور أو مفتاح المرور أنك أنت. حاول مرة أخرى.",
      "settings.about.revealHome": "إظهار في الملفات",
      "settings.uninstall.keychainStays":
        "تبقى عناصر سلسلة مفاتيح النظام (مفتاح الخزنة وعناصر المساعد). أزلها في تطبيق سلسلة المفاتيح لديك إن أردت.",
      "settings.uninstall.keychainGoes":
        "تُزال أيضًا عناصر سلسلة مفاتيح النظام الخاصة بالخزنة والمساعد.",
      "settings.uninstall.removeKeychain":
        "أزل أيضًا عناصر سلسلة مفاتيح النظام الخاصة بي (الخاصة بـ Psyche). بدون بياناتك لا فائدة منها.",
      "settings.uninstall.presence":
        "ثم سيُطلب منك التأكيد باستخدام كلمة المرور أو على هذا الجهاز، لأن ذلك يزيل بياناتك.",
      "settings.appearance.showInDockHint":
        "عند الإيقاف، يستمر Psyche في العمل في علبة النظام عند إغلاق آخر نافذة.",
      "settings.appearance.openAtLoginHint":
        "يشغّل Psyche في علبة النظام عند تسجيل الدخول، لتعمل الأتمتة المجدولة دائمًا.",
      "settings.browser.letTasksUseHint":
        "لا تزال كل مهمة تسألك أولًا، على هذا الجهاز عبر كلمة المرور أو مفتاح مرور.",
      "settings.browser.detailsText":
        "أثناء استخدام مهمة له، يشغّل Psyche متصفح Google Chrome بهذا الملف التعريفي ومنفذ DevTools على عنوان الاسترجاع (127.0.0.1) لهذا الكمبيوتر، ويغلقه عند انتهاء المهمة. لا يكون {persona} متصلًا به أثناء فتحك الملف التعريفي بنفسك.",
      "settings.browser.openFromMac": "افتحه من تطبيق Psyche على الكمبيوتر الذي يشغّل Gateway.",
      "settings.channels.empty":
        "لا قنوات بعد. اربط Telegram أو Slack للوصول إلى {persona} بعيدًا عن هذا الكمبيوتر.",
      "settings.computerUse.description":
        "يمكن لـ {persona} استخدام التطبيقات على هذا الكمبيوتر حيث تسمح له فقط.",
      "settings.computerUse.macPermissions": "أذونات سطح المكتب",
      "settings.computerUse.openSystemSettingsFor": "فتح الإعدادات لـ {name}",
      "settings.computerUse.openSystemSettings": "فتح الإعدادات",
      "settings.trusted.loading": "جارٍ قراءتها من هذا الكمبيوتر…",
      "settings.trusted.noHelper": "افتح Psyche على الكمبيوتر الخاص بك لسردها: يقرؤها المساعد.",
      "settings.trusted.failed": "تعذّر على Psyche قراءتها من هذا الكمبيوتر.",
      "settings.mcp.sandboxHelp": "تحتاج خوادم الأوامر إلى بيئة معزولة على هذا الكمبيوتر.",
      "settings.sandbox.why":
        "تعمل الأوامر على الكمبيوتر الخاص بك مع ملفاتك، لكنها لا تستطيع قراءة خزنتك أو مفاتيحك أو بيانات Psyche الخاصة.",
      "settings.sandbox.whyHow":
        "تستخدم srt، بيئة التشغيل المعزولة من Anthropic، مع العزل الأصلي في Linux (bubblewrap). لا حاجة إلى آلة افتراضية.",
      "settings.sandbox.checking": "جارٍ فحص هذا الكمبيوتر…",
      "settings.sandbox.containers.body":
        "تشغّل بيئة الحاويات الشيفرة في آلة Linux خاصة بها دون وصول إلى ملفات الكمبيوتر الخاص بك: للشيفرة التي يشغّلها الوكيل وبعض تحويلات الملفات. تواصل خوادم الأوامر استخدام srt ما لم يُضبط Gateway على استخدام الحاويات.",
      "settings.searchSources.description":
        "ما يقرؤه Psyche في فهرس بحثك. كلها متوقفة حتى تفعّلها؛ ويبقى الفهرس على هذا الكمبيوتر. تفعيل مصدر يتيح للذاكرة التعلم منه أيضًا، ما لم تلغِ ذلك في الذاكرة ← المصادر (الذاكرة وجهات الاتصال استثناءان: لا يُتعلَّم من أي منهما).",
      "settings.searchSources.runOnBatteryHint":
        "يتيح مواصلة الفهرسة وإعادة البناء وقراءة النص في الصور أثناء عمل الكمبيوتر على البطارية، بوتيرة أهدأ. يستهلك مزيدًا من البطارية. ويظل موفّر الطاقة يوقف الفهرسة.",
      "settings.searchSources.ocrHint":
        "يقرأ لقطات الشاشة وملفات PDF الممسوحة ضوئيًا، صفحة صفحة، عند التوصيل بالطاقة (أو على البطارية عند تفعيل «الفهرسة على البطارية»). لا شيء يغادر الكمبيوتر الخاص بك.",
      "settings.semanticSearch.description":
        "يجد الأشياء بمعناها وبكلماتها معًا، كل ذلك على هذا الكمبيوتر.",
      "settings.semanticSearch.engine.builtinHint":
        "Multilingual E5 small، نحو 100 لغة، يعمل على معالج هذا الكمبيوتر.",
      "settings.semanticSearch.engine.routerHint":
        "يستخدم نموذج التضمين المحدد في الأدوار، مثل Ollama أو LM Studio على هذا الكمبيوتر.",
      "settings.semanticSearch.allowCloudHint":
        "فقط إذا كان نموذج التضمين خدمة سحابية. تُرسل إليه دردشاتك ومهامك ونصوص المكتبة. الإيقاف يُبقي كل شيء على هذا الكمبيوتر.",
      "settings.semanticSearch.state.cloudBlocked":
        "نموذج التضمين في الأدوار خدمة سحابية. يستخدم البحث الدلالي النماذج الموجودة على هذا الكمبيوتر فقط.",
      "settings.data.encryptMemory.pending": "بانتظار المفتاح من مساعد Linux.",
      "settings.devices.touchId.none":
        "لا مفتاح لكلمة المرور بعد. لا يمكن الموافقة على البطاقات التي تحتاج إلى كلمة المرور حتى يُسجَّل مفتاح.",
      "settings.devices.touchId.noBundledKey":
        "لا يملك مساعد Linux في هذا التطبيق مفتاح موافقة ({reason}).",
      "settings.devices.touchId.manualHint":
        "شغّل psyche-helper --print-identity على الكمبيوتر والصق presenceKeyId الذي يطبعه.",
      "settings.devices.noNodes":
        "لا عُقد. يظهر مساعد Linux هنا بمجرد تشغيل Psyche على هذا الكمبيوتر.",
      "settings.files.execHost": "تشغيل الأوامر على هذا الكمبيوتر",
      "settings.files.execHostSwitch": "السماح بالأوامر على هذا الكمبيوتر",
      "settings.model.ram.tooSmall":
        "يملك هذا الكمبيوتر {gb, number} ج.ب. تحتاج النماذج المحلية إلى {min, number} ج.ب على الأقل؛ استخدم مزوّدًا سحابيًا بدلًا من ذلك.",
      "settings.model.ram.fits": "يملك هذا الكمبيوتر {gb, number} ج.ب، لذا تناسبه {fits}.",
      "settings.model.ram.thisMac": " (هذا الكمبيوتر)",
      "settings.model.localHint": "شغّل النماذج على هذا الكمبيوتر باستخدام Ollama أو LM Studio.",
      "settings.permissions.never.browserPasswords":
        "قراءة كلمات المرور المحفوظة في متصفحاتك أو في سلسلة مفاتيح النظام",
      "settings.server.bindHint":
        "يبقيه 127.0.0.1 على هذا الكمبيوتر. استخدم الوصول عن بُعد أدناه بدلًا من الربط بكل الواجهات.",
      "settings.gateways.description":
        "استخدم Psyche من هذا الكمبيوتر عبر Gateway على كمبيوتر آخر، مثل الكمبيوتر في منزلك. يعمل Gateway واحد في كل مرة، والتبديل يعيد تشغيل Psyche.",
      "settings.gateways.thisMac": "هذا الكمبيوتر",
      "settings.gateways.switchKeep":
        "يعاد تشغيل Psyche على {name}. يواصل Psyche على هذا الكمبيوتر العمل، فتستمر أتمتته.",
      "settings.gateways.switchAndStop": "التبديل وإيقاف Psyche على هذا الكمبيوتر",
      "settings.gateways.addHint":
        "الصق رابط الإقران من الكمبيوتر الذي يشغّل Psyche (الإعدادات ← الخادم والوصول عن بُعد ← إقران كمبيوتر آخر). وبدون رابط، اكتب عنوان Tailscale الخاص به https://<host>.<tailnet>.ts.net؛ عندها يطلب هذا الكمبيوتر الإقران ويوافق عليه المالك هناك.",
      "settings.gateways.problem.link_malformed":
        "رابط الإقران هذا تالف. انسخه مجددًا من الكمبيوتر الذي أنشأه.",
      "settings.gateways.problem.link_bad_field":
        "رابط الإقران هذا تالف. انسخه مجددًا من الكمبيوتر الذي أنشأه.",
      "settings.gateways.problem.link_lan":
        "رابط الإقران هذا لكمبيوتر على شبكتك المحلية لكنه لا يحمل شهادته، لذا لا يُستخدم. على ذلك الكمبيوتر أنشئ رابطًا جديدًا: إقران كمبيوتر آخر ← من هذه الشبكة.",
      "settings.remote.description":
        "دع Psyche على كمبيوتر آخر يستخدم Gateway هذا الكمبيوتر عبر Tailscale. يبقى Gateway على هذا الكمبيوتر ولا يستمع إلا إلى Tailscale، وTailscale Serve هو المدخل الوحيد.",
      "settings.remote.step1":
        "ثبّت Tailscale على هذا الكمبيوتر وعلى الكمبيوتر الآخر، وسجّل دخول الاثنين إلى tailnet نفسها.",
      "settings.remote.step2":
        "في طرفية على هذا الكمبيوتر، انشر Gateway على tailnet الخاصة بك. هذا Serve وليس Funnel.",
      "settings.remote.step4":
        "أعد تشغيل Psyche. ثم على الكمبيوتر الآخر أضف هذا الكمبيوتر كـ Gateway. سيعرض رمز إقران وبصمة مفتاح: قارنهما بالطلب ضمن «بانتظار الإقران» هنا، ثم وافق عليه.",
      "settings.remote.admin":
        "يحصل الكمبيوتر المقترن على القراءة والكتابة والموافقات. تبقى صلاحية المسؤول متوقفة ما لم تحدّدها عند الموافقة، وكل تغيير إداري يتطلب كلمة المرور منك هنا.",
      "settings.pair.needsAddress":
        "اضبط العنوان العام لهذا الكمبيوتر أولًا (الخطوة 3 أعلاه)، ثم أنشئ رابط إقران.",
      "settings.pair.adminHint":
        "تتيح صلاحية المسؤول له تغيير إعدادات الأمان والأجهزة والخزنة، وتبقى متوقفة ما لم تحدّدها. كل تغيير إداري يتطلب كلمة المرور منك هنا.",
      "settings.pair.compare":
        "يتحقق من مفتاح هذا الكمبيوتر قبل أن يستخدم الرابط: {fingerprint}. يمكنك المقارنة.",
      "settings.pair.secret":
        "يمكن لأي شخص يملك هذا الرابط خلال العشر دقائق القادمة إقران كمبيوتر واحد. لا تنشره ولا ترسله إلى من لا تثق بهم مع هذا الكمبيوتر.",
      "settings.pair.err.noAddress": "ليس لهذا الكمبيوتر عنوان عام بعد، فلا شيء يوضع في الرابط.",
      "settings.pair.viaAddress": "عبر Tailscale، على عنوان هذا الكمبيوتر",
      "settings.pair.viaLanHint":
        "يحمل رابط هذه الشبكة مفتاح هذا الكمبيوتر وشهادته، لذا يعمل فقط للأجهزة على شبكة Wi-Fi أو Ethernet نفسها.",
      "settings.pair.lanNote":
        "هذا الرابط لأجهزة على الشبكة نفسها التي عليها هذا الكمبيوتر. وهو يحدد المفتاح والشهادة اللذين سيصر عليهما Psyche.",
      "settings.lan.description":
        "دع Psyche على كمبيوتر آخر على شبكة Wi-Fi أو Ethernet نفسها يصل إلى Gateway هذا الكمبيوتر دون Tailscale. متوقف حتى تفعّله.",
      "settings.lan.toggleHint":
        "يستمع Psyche على شبكة واحدة عبر اتصال مشفّر بشهادته الخاصة. ويظل الكمبيوتر المتصل بحاجة إلى موافقة هنا بكلمة المرور.",
      "settings.lan.noInterface": "لم يُعثر على اتصال Wi-Fi أو Ethernet على هذا الكمبيوتر.",
      "settings.lan.notAdvertised": "لا يظهر. أضف هذا الكمبيوتر بعنوانه.",
      "settings.lan.problem.unknownInterface": "{name} ليست شبكة على هذا الكمبيوتر.",
      "settings.lan.problem.advertise":
        "تعذّر على Psyche الإعلان عن نفسه على الشبكة. ما زال بإمكان الأجهزة إضافة هذا الكمبيوتر بعنوانه.",
      "settings.server.noVm":
        "لا VM. يشغّل وضع VM تطبيق Psyche داخل كمبيوتر ضيف منفصل؛ أعدّه من الإعداد الأولي.",
      "settings.shortcut.key.Control": "Ctrl",
      "settings.shortcut.key.Alt": "Alt",
      "settings.skills.permission.exec_host": "تشغيل أوامر على هذا الكمبيوتر",
      "settings.skills.permission.computer_action": "استخدام التطبيقات على هذا الكمبيوتر",
      "settings.skills.pathPlaceholder": "/home/you/Downloads/pdf-merge",
      "settings.skills.signer.originAgent":
        "كتبها مساعد على كمبيوتر المرسل. اقرأها كنص غير مُراجَع، أيًّا كان من وقّعها.",
      "settings.skills.export.hint":
        "يُوقَّع الملف بمفتاح مؤلفك، فيعرف من يتلقاه أنه منك وأنه لم يتغير. يبقى المفتاح على هذا الكمبيوتر.",
      "settings.vm.phase.installing": "جارٍ إعداد الضيف",
      "settings.vm.description":
        "شغّل المهام في كمبيوتر معزول منفصل، بحيث يعمل {persona} في نسخته الخاصة من Linux بدلًا من نسختك.",
      "settings.vm.sandboxMac": "الكمبيوتر المعزول",
      "settings.vm.between": "بين الكمبيوتر الخاص بك والضيف",
      "settings.vm.credentialsHint":
        "مع خزنة المضيف تبقى القيم على الكمبيوتر الخاص بك. وتحتفظ خزنة الضيف بنسختها الخاصة.",
      "settings.vm.noReports":
        "لم يبلّغ أي ضيف بعد. أنشئ واحدًا من مساعد Psyche على هذا الكمبيوتر؛ وتظهر حالته هنا.",
      "settings.voice.key.rightOption": "Alt الأيمن",
      "settings.voice.key.rightCommand": "Ctrl الأيمن",
      "settings.voice.reply.gatewayHint": "الصوت المضبوط للشخصية، أو صوت النظام.",
      "settings.voice.engine.local": "على هذا الكمبيوتر",
      "settings.voice.engine.localHint": "يعمل Whisper محليًا؛ ولا يغادر الصوت الكمبيوتر أبدًا.",
      "settings.voice.engine.system": "إملاء النظام",
      "settings.voice.engine.systemHint":
        "محرك التعرّف على الكلام الموجود على الجهاز في النظام، عبر مساعد Linux.",
      "settings.voice.model.usingHelper":
        "يستخدم الإملاء ميزة التعرّف على الكلام في المساعد. ويكتب نموذج الكلام النص بدقة أفضل ويعمل على هذا الكمبيوتر.",
      "settings.voice.model.downloadHint":
        "تنزيل لمرة واحدة من مشروع whisper.cpp، يُفحص قبل استخدامه. لا يغادر الصوت هذا الكمبيوتر أبدًا.",
      "settings.voice.model.ready": "Whisper ({model}) على هذا الكمبيوتر",
      "settings.voice.model.readyHint":
        "يُحوَّل الإملاء والتسجيلات إلى نص هنا؛ ولا يغادر الصوت الكمبيوتر أبدًا.",
      "settings.connect.finishOpened":
        "فُتح تسجيل الدخول إلى {name} في متصفحك على الكمبيوتر الذي يشغّل Gateway. يتحدّث هذا عند انتهائك.",
      "settings.connect.needsPermission": "{name} مُعَدّ، لكن النظام لم يسمح به بعد. اسمح به في",
      "settings.connect.openSystemSettings": "فتح الإعدادات",
      "settings.people.description":
        "البطاقات التي يحتفظ بها {persona} للأشخاص والمشاريع في حياتك. تبقى على هذا الكمبيوتر، وتعرض كل معلومة مصدرها.",
      "settings.about.versionsHint": "ما يعمل على هذا الكمبيوتر.",
      "settings.computerUse.macPermissionsHint": "ما يسمح به سطح المكتب.",
      "settings.connectorBundle.sandbox.none":
        "لا توجد في هذا الكمبيوتر بيئة معزولة لموصّلات الأوامر، ولا يشغّل Psyche أيًّا منها خارجها. لا يمكن تثبيت هذا الموصّل هنا. لم يُشغَّل أو يُحفظ أي شيء.",
      "settings.connectorBundle.share.unavailable":
        "لا يستطيع توقيع الموصّل إلا Psyche على الكمبيوتر الذي يشغّله.",
      "settings.deviceAccess.files.title": "الملفات على هذا الكمبيوتر",
      "settings.deviceAccess.terminal.hint":
        "يستطيع {persona} تشغيل أوامر الطرفية على هذا الكمبيوتر عندما يكون «تشغيل الأوامر على هذا الكمبيوتر» مفعّلًا في الأذونات ← الوصول.",
      "settings.deviceAccess.terminal.where":
        "تعمل الأوامر على الكمبيوتر الخاص بك، في المجلدات التي شاركتها، ولا تكتب إلا في مجلد شاركته للقراءة والكتابة.",
      "settings.mcp.needs.title": "ما يحتاج إليه هذا على الكمبيوتر الخاص بك",
      "settings.mcp.needs.node.fix":
        "يعمل على Node الخاص بـ Psyche؛ ويحتاج إلى npm على هذا الكمبيوتر. ثبّت Node.js من nodejs.org، أو عبر مدير الحزم لديك.",
      "settings.mcp.needs.uv.fix": "خادم Python. ثبّت uv من docs.astral.sh/uv.",
      "settings.mcp.fail.node_missing":
        "ثبّت Node.js (nodejs.org، أو عبر مدير الحزم لديك) ليتوفر npm على هذا الكمبيوتر، ثم تحقق مجددًا.",
      "settings.mcp.fail.uv_missing": "ثبّت uv (docs.astral.sh/uv) ثم افحص الخادم مجددًا.",
      "settings.mail.voice.learn.hint":
        "تقرأ Wren ما كتبتَه فقط في البريد المُرسَل، دون النص المقتبس أو التوقيعات. يبقى الملف الشخصي على هذا الكمبيوتر في mail/VOICE.md.",
      "settings.mail.voice.localModel.hint": "المسودات بأسلوبك لا تغادر هذا الكمبيوتر أبدًا.",
      "settings.mail.transcribe.endpoint.hint":
        "اختياري. خادم متوافق مع OpenAI على /v1/audio/transcriptions (مثل whisper.cpp على هذا الكمبيوتر). يُستخدم عندما لا يكون لدى مساعد Linux محرك كلام. يُرسل الصوت إلى هذا العنوان فقط: https، أو http على 127.0.0.1.",
      "onboarding.mail.voiceHint":
        "يقرأ ما كتبتَه فقط، دون النص المقتبس أو التوقيعات. يبقى على هذا الكمبيوتر ويمكنك عرضه أو تعديله أو إعادة ضبطه.",
      "gallery.preset.git.field.repo.help":
        "مجلد مستودع Git على هذا الكمبيوتر. يستطيع Psyche قراءة سجله وفروقه.",
      "settings.connectors.page.onThisMac": "على هذا الكمبيوتر",
      "settings.connectors.page.row.local": "يعمل على هذا الكمبيوتر",
      "settings.connectors.page.server.local": "أداة تعمل في بيئة معزولة على هذا الكمبيوتر",
      "onboarding.permission.denied": "متوقف في الإعدادات",
      "onboarding.permission.deniedHint": "شغّله في إعدادات النظام؛ تتحدّث هذه الصفحة عند عودتك.",
      "onboarding.permission.unavailableHint":
        "لا يمكن لـ Psyche طلب هذا إلا في تطبيق Psyche لسطح المكتب.",
      "onboarding.connectors.onThisMac": "على هذا الكمبيوتر",
      "onboarding.connectors.onThisMacHint":
        "يطلب كل تطبيق إذن النظام عند اتصاله، واحدًا تلو الآخر.",
      "onboarding.model.kind.localHint": "يعمل على هذا الكمبيوتر؛ ولا يغادره شيء.",
      "onboarding.model.subscriptionNote":
        "يستخدم Psyche تطبيق Claude Code أو Codex المسجّل الدخول بالفعل على هذا الكمبيوتر، لذا لا يحتاج إلى مفتاح API ولا يخزّن أيًا منه. سجّل الدخول هناك أولًا إن لم تفعل.",
      "onboarding.safety.touchId": "كلمة المرور للموافقات",
      "onboarding.safety.touchId.checking": "جارٍ فحص مساعد Linux…",
      "onboarding.safety.touchId.setHint": "الموافقات التي تحتاج إليك تطلب كلمة المرور.",
      "onboarding.safety.touchId.starting": "ما زال مساعد Linux يبدأ. تحقق مجددًا بعد قليل.",
      "onboarding.safety.touchId.noKey": "ليس لدى مساعد Linux مفتاح موافقة ({reason}).",
      "onboarding.safety.touchId.hint":
        "سجّل مفتاح مساعد Linux مرة واحدة ليتمكن من تأكيد الموافقات بكلمة المرور.",
      "onboarding.safety.asks":
        "إذا سمحت لـ {name} بتشغيل الأوامر على هذا الكمبيوتر، فالأوامر التي تقرأ فقط مثل ls أو cat تعمل دون بطاقة. أما أي شيء آخر فيسألك أولًا.",
      "onboarding.done.touchId": "كلمة المرور",
      "onboarding.done.try.search":
        "اطرح سؤالًا في البحث (Ctrl+K). تُظهر الإجابة من أين في حياتك جاءت.",
      "screens.search.source.revealFile": "إظهار في الملفات",
      "everything.model.localHint":
        "يقرأ نموذج على هذا الكمبيوتر كل شيء. لا شيء يغادر الكمبيوتر. حقائق أقل وأكثر تشويشًا.",
      "everything.run.reason.battery":
        "ليس الآن: الكمبيوتر يعمل على البطارية. وصّله بالطاقة، أو اسمح بالتشغيل على البطارية.",
      "everything.run.reason.thermal": "ليس الآن: الكمبيوتر ساخن جدًا.",
      "everything.run.reason.not_idle": "ليس الآن: أنت تستخدم الكمبيوتر.",
      "everything.storage.note": "كل شيء مخزّن على هذا الكمبيوتر فقط.",
      "memoryWork.consent.k1": "لا شيء يغادر هذا الكمبيوتر. تُحسب التواريخ والحالات بالشيفرة.",
      "screens.library.reveal": "إظهار في الملفات",
      "web.zoom.description":
        "حجم عرض التطبيق على هذا الكمبيوتر. يغيّر Ctrl+Plus وCtrl+Minus الإعداد نفسه، لذا يبقى بعد إعادة التشغيل؛ {min, number}–{max, number} ٪.",
      "web.transcriptMode.optionTitle": "{mode} (Ctrl+O للتنقل)",
      "web.backups.restore": "الاستعادة على كمبيوتر جديد مع إيقاف Gateway:",
      "web.passkeys.firstApproval":
        "وافق على «إضافة مفتاح مرور» بكلمة المرور على الكمبيوتر الخاص بك أو بمفتاح مرور على جهاز آخر، ثم اضغط «إضافة» مرة أخرى.",
      "web.passkeys.added":
        "تمت إضافة {name}. يوافق الآن على التغييرات التي تحتاج إلى كلمة المرور أو مفتاح مرور.",
      "web.remotePresence.title": "كلمة المرور للموافقات",
      "web.remotePresence.description":
        "تحتاج عمليات الشراء وتعبئة بيانات الاعتماد وأوامر المضيف وتغييرات الأمان إلى كلمة المرور أو مفتاح مرور. أعدّها على هذا الكمبيوتر لتجيب هنا؛ وإلى ذلك الحين تطلب هذه البطاقات الإجابة على {host}. الموافقات العادية لا تحتاج إليها أبدًا.",
      "web.remotePresence.on": "الموافقات بكلمة المرور مفعّلة لهذا الكمبيوتر.",
      "web.remotePresence.off": "لم تُعدّ الموافقات بكلمة المرور على هذا الكمبيوتر.",
      "web.remotePresence.enable": "استخدام كلمة المرور للموافقات على هذا الكمبيوتر",
      "web.remotePresence.waiting": "بانتظار كلمة المرور…",
      "web.remotePresence.passkeyName": "كلمة المرور على هذا الكمبيوتر",
      "web.remotePresence.enabled": "الموافقات بكلمة المرور مفعّلة لهذا الكمبيوتر.",
      "web.remotePresence.disabled": "الموافقات بكلمة المرور متوقفة على هذا الكمبيوتر.",
      "web.remotePresence.approveOnHost":
        "وافق على «إضافة مفتاح مرور» على {host} بواسطة Touch ID أو Windows Hello أو كلمة المرور فيه، أو بمفتاح مرور، ثم اضغط الزر مجددًا.",
      "web.remotePresence.unavailable":
        "تحتاج الموافقات بكلمة المرور إلى Gateway الخاص بـ {host} على عنوان https:// (gateway.publicOrigin). وإلى ذلك الحين أجب عن هذه البطاقات على {host}.",
      "web.webauthn.noPasskeyYet":
        "لا مفتاح مرور في هذا المتصفح بعد. أضف واحدًا في الإعدادات ← الأجهزة والعُقد، أو وافق على الكمبيوتر الذي يشغّل Gateway.",
      "web.webauthn.needsOrigin":
        "تحتاج مفاتيح المرور إلى عنوان https للخادم (gateway.publicOrigin). وافق على الكمبيوتر الذي يشغّل Gateway بدلًا من ذلك.",
      "web.setup.gatewayOk": "يعمل على هذا الكمبيوتر.",
      "web.setup.adminOk": "هذا الكمبيوتر هو جهاز المسؤول.",
      "web.viewers.noSandbox":
        "تحتاج معاينات الشرائح إلى البيئة المعزولة، ولا تتوفر بيئة تشغيل حاويات (Docker أو Podman).",
      "web.voice.noEngine":
        "لا محرك كلام متاح. ثبّت نموذج كلام في الإعدادات ← الصوت، أو اربط مساعد Linux.",
      "web.threads.newSideChatTitle": "دردشة جانبية جديدة (Ctrl+N)",
      "web.panes.closePaneTitle": "إغلاق اللوحة (Ctrl+\\)",
      "web.chat.permissionModeTitle": "وضع الأذونات (Ctrl+Shift+M)",
      "web.chat.modelTitle": "النموذج (Ctrl+Shift+I)",
      "web.splash.installing": "جارٍ إعداد Psyche على هذا الكمبيوتر…",
      "web.splash.helper": "جارٍ تجهيز Psyche على الكمبيوتر الخاص بك…",
      "web.splash.remote.useThisMac": "استخدام هذا الكمبيوتر",
      "web.remote.thisMac": "هذا الكمبيوتر",
      "web.teach.bar.body":
        "يدوّن Psyche نقراتك وكتابتك في هذا التبويب فقط. لا تُسجَّل كلمات المرور وأرقام البطاقات والرموز أبدًا، ولا يغادر شيء هذا الكمبيوتر حتى تحفظ.",
      "settings.teach.storage.description":
        "عندما تطلب من Psyche الاحتفاظ بتسجيل لتصنع نسخة أخرى، تُحفظ الخطوات على هذا الكمبيوتر.",
      "settings.teach.storage.encrypted":
        "مشفّر. الملف مقفل بمفتاح محفوظ في سلسلة مفاتيح النظام، فلا يمكن قراءته خارج Psyche. تنتهي صلاحيته بعد 90 يومًا.",
      "settings.teach.storage.unavailable":
        "لا تُحفظ التسجيلات. سلسلة مفاتيح النظام غير متاحة، ولن يحفظ Psyche تسجيلًا كنص عادي. ما زال بإمكانك حفظ التسجيل كمهارة.",
      "web.teach.review.keepUnavailable":
        "غير متاح: سلسلة مفاتيح النظام غير متاحة لتشفير تسجيل محفوظ.",
      "web.teach.review.keepRecording": "الاحتفاظ بهذا التسجيل على هذا الكمبيوتر لأصنع نسخة أخرى",
      "web.teach.app.recordHint": "أرِ Psyche كيف تنجز أمرًا في تطبيق سمحت به من قبل",
      "web.teach.app.bar.body":
        "يدوّن Psyche نقراتك واختياراتك من القوائم وما تكتبه في {app} فقط. لا تُسجَّل الحقول الآمنة أبدًا، ولا تُلتقط لقطات شاشة، ولا يغادر شيء هذا الكمبيوتر حتى تحفظ. ويوجد في علبة النظام أيضًا زر إيقاف.",
      "voice.key.rightOption": "Alt الأيمن",
      "voice.key.rightCommand": "Ctrl الأيمن",
      "voice.settings.reviewHint":
        "يُبقي ما سمعه Psyche في النافذة المنبثقة لتصحّحه ثم تضغط Enter. عند الإيقاف، يُرسَل حين تُفلت المفتاح.",
      "meetingRecord.unavailable":
        "يحتاج التسجيل إلى وسيلة لتحويل الصوت إلى ملاحظات (نموذج كلام أو مساعد Linux)، ولا توجد وسيلة متصلة.",
      "meetingRecord.micDenied": "لا يستطيع Psyche استخدام الميكروفون. اسمح به في إعدادات النظام.",
      "platform.term.os": "Linux",
      "platform.term.device": "كمبيوتر",
      "platform.term.thisDevice": "هذا الكمبيوتر",
      "platform.term.thisDeviceLower": "هذا الكمبيوتر",
      "platform.term.presence": "كلمة المرور",
      "platform.term.secretStore": "سلسلة مفاتيح النظام",
      "platform.term.systemSettings": "الإعدادات",
      "platform.term.fileManager": "الملفات",
      "platform.term.trayArea": "علبة النظام",
      "platform.term.taskbar": "شريط المهام",
      "platform.term.systemSearch": "بحث سطح المكتب",
      "platform.term.helper": "مساعد Linux",
      "platform.term.terminal": "الطرفية",
      "platform.term.alt": "Alt",
      "platform.term.mod": "Ctrl",
      "web.security.banner.recovery":
        "{count, plural, one {تغيير أمان طُلب على هذا الكمبيوتر سيُطبَّق في {when} ما لم تلغه.} two {تغييرا أمان طُلبا على هذا الكمبيوتر ينتظران. التالي يُطبَّق في {when}.} few {# تغييرات أمان طُلبت على هذا الكمبيوتر تنتظر. التالي يُطبَّق في {when}.} many {# تغيير أمان طُلب على هذا الكمبيوتر ينتظر. التالي يُطبَّق في {when}.} other {# تغيير أمان طُلب على هذا الكمبيوتر ينتظر. التالي يُطبَّق في {when}.}}",
      "web.security.alert.changed":
        "غيّر برنامج على هذا الكمبيوتر {count, plural, one {سجل أمان واحدًا} two {سجلَّي أمان} few {# سجلات أمان} many {# سجل أمان} other {# سجل أمان}} دون المرور عبر Psyche. أعاد Psyche ما تغيّر كما كان. إن لم تكن أنت من فعل ذلك، فافحص الكمبيوتر بحثًا عن برامج غير مرغوب فيها.",
      "web.security.alert.untrusted":
        "فشل فحص سجلات الأمان في Psyche. الأجهزة الجديدة وإعدادات الأمان والموافقات بكلمة المرور محظورة. راجع أجهزتك ثم شغّل psyched security reseal على الكمبيوتر؛ يُطبَّق ذلك بعد 24 ساعة.",
      "web.security.alert.firstAdmin":
        "جعل أمر على هذا الكمبيوتر الجهاز {name} أول جهاز مسؤول. إن لم تكن أنت، فألغِه من الأجهزة.",
      "web.security.alert.requested": "طُلب على هذا الكمبيوتر: {action} يُطبَّق في {when}.",
      "web.security.op.presenceReset":
        "التوقف عن طلب كلمة المرور أو مفتاح المرور لتغييرات الأمان حتى يُسجَّل مفتاح جديد.",
      "web.security.needsApproval":
        "وافق على البطاقة بكلمة المرور أو مفتاح مرور، ثم اضغط الزر مرة أخرى.",
    },
    de: {
      "settings.devices.nodeKind.hostHelper": "Linux-Helfer",
      "settings.links.description":
        "Wo ein Link in einer Chatnachricht, Karte oder einem Artefakt geöffnet wird. Ctrl+Klick nutzt immer deinen Standardbrowser.",
      "errors.presence_required":
        "Bestätige zuerst mit deinem Passwort oder einem Passkey, dass du es bist.",
      "chat.toolbar.keySheet": "Ctrl+Shift+A",
      "chat.toolbar.keyModel": "Ctrl+Shift+I",
      "chat.toolbar.keyView": "Ctrl+O",
      "chat.approval.keysHint": "Ctrl+Enter {allows} · Ctrl+D {denies}",
      "blocks.details.runsOnHost": "auf deinem Computer, außerhalb der Sandbox",
      "blocks.details.runsSandboxed":
        "auf deinem Computer, in der Sandbox: Sie kann weder den Tresor von Psyche noch deine SSH-Schlüssel, den Systemschlüsselbund oder Browserprofile lesen",
      "blocks.details.runsNoSandbox":
        "auf deinem Computer, und die Sandbox ist nicht eingerichtet ({reason})",
      "blocks.permission.need.capability": "„Befehle auf diesem Computer ausführen“ aktivieren",
      "blocks.permission.need.macos_access": "{connector} Zugriff in den Einstellungen geben",
      "blocks.permission.openSystemSettings": "Einstellungen öffnen",
      "blocks.approval.answerOnHost":
        "Antworte auf {host} oder richte unter Einstellungen → Geräte Passwort-Genehmigungen für diesen Computer ein.",
      "blocks.approval.needsAuth": "Zum Genehmigen sind dein Passwort oder ein Passkey nötig.",
      "blocks.approval.touchIdFailed":
        "Die Passwortprüfung ist fehlgeschlagen: {reason}. Versuche es erneut.",
      "blocks.approval.touchIdFailedNoReason":
        "Die Passwortprüfung ist fehlgeschlagen. Versuche es erneut.",
      "blocks.approval.touchId.helperOffline":
        "Der Linux-Helfer läuft nicht, daher kann dein Passwort das hier nicht bestätigen.",
      "blocks.approval.touchId.noKey":
        "Passwort-Genehmigungen sind auf diesem Computer noch nicht eingerichtet. Richte sie unter Einstellungen → Geräte ein, wo du den Schlüssel vorher prüfen kannst.",
      "blocks.approval.touchId.invalidated":
        "Deine Passworteinrichtung hat sich geändert, seit der Schlüssel dieses Computers eingerichtet wurde, daher kann er keine Genehmigungen bestätigen. Richte ihn unter Einstellungen → Geräte neu ein.",
      "blocks.approval.touchId.noUnsandboxed":
        "Ein Befehl ohne Sandbox lässt sich aus diesem Fenster nicht per Passwort genehmigen. Richte stattdessen die Sandbox ein",
      "blocks.approval.touchId.onceOnly":
        "Passwort-Genehmigungen aus diesem Fenster gelten nur einmal.",
      "blocks.approval.status.allowedOnceTouchId":
        "Einmal erlaubt (Passwort-Genehmigungen aus diesem Fenster gelten nur einmal)",
      "blocks.approval.touchId.keyUnavailable":
        "Dieser Build des Linux-Helfers kann keinen Genehmigungsschlüssel speichern, daher lassen sich Karten, die dein Passwort brauchen, auf diesem Computer nicht genehmigen.",
      "blocks.approval.touchId.cancelled":
        "Die Passwortabfrage wurde abgebrochen, daher wurde nichts genehmigt",
      "shell.shortcut.pushToTalkKeys": "Ctrl rechts halten",
      "settings.shared.needsPresence":
        "Das Ändern von „{label}“ braucht deine Genehmigung mit deinem Passwort oder einem Passkey. Genehmige es in den Einstellungen oder in der Psyche-Mitteilung und ändere es dann erneut.",
      "settings.page.permissions.description":
        "Was {persona} auf diesem Computer ohne Nachfragen tun darf und wo es immer bei dir nachfragt.",
      "settings.page.data.description":
        "Was auf diesem Computer bleibt, wie lange es aufbewahrt wird, Exporte, Backups und Neuanfang.",
      "settings.essentials.model.noneHint":
        "{persona} braucht ein Modell, bevor es antworten kann. Füge einen Schlüssel hinzu oder nutze ein Modell auf diesem Computer.",
      "settings.essentials.read.hint":
        "Aus, bis du eines einschaltest. Was gelesen wird, wird auf diesem Computer indexiert, damit es Dinge für dich finden kann, und das Gedächtnis lernt ebenfalls daraus, außer du widersprichst unter Gedächtnis → Quellen.",
      "settings.searchModel.apple.notOnThisMac": "Auf macOS verfügbar",
      "settings.macHelper.paired.text":
        "Führt Computersteuerung, Bildschirmkontext, Diktat, Passwort-Genehmigungen und Mitteilungen auf diesem Computer aus.",
      "settings.macHelper.unbundled.text": "Dieser Build von Psyche hat keinen Linux-Helfer.",
      "settings.key.appearance.showInDock":
        "In der Taskleiste zeigen, wenn keine Fenster offen sind",
      "settings.semanticSearch.encrypt.pending":
        "Wartet darauf, dass der Linux-Helper den verschlüsselten Index öffnet",
      "settings.semanticSearch.rerankHint":
        "Ein kleines Cloud-Modell setzt die besten Ergebnisse nach vorn. Die obersten 20 Ausschnitte verlassen diesen Computer. Standardmäßig aus.",
      "settings.key.vm.enabled": "Sandbox-Computer für Aufgaben verwenden",
      "settings.key.vm.resetPerTask": "Frischer Computer für jede Aufgabe",
      "settings.credentials.backend.psyche": "Psyche-Tresor (dein Passwort)",
      "settings.credentials.backend.keychain": "Systemschlüsselbund",
      "settings.credentials.backendIn.keychain": "im Systemschlüsselbund",
      "settings.credentials.err.lockedChange":
        "Der Tresor ist gesperrt. Entsperre ihn mit deinem Passwort und {verb, select, delete {lösche} other {ändere}} {name} dann erneut.",
      "settings.credentials.err.lockedImport":
        "Der Tresor ist gesperrt. Entsperre ihn mit deinem Passwort und importiere dann erneut.",
      "settings.credentials.slot.keychain": "den Systemschlüsselbund (dein Passwort)",
      "settings.credentials.slot.safeStorage": "den App-Speicher dieses Computers",
      "settings.credentials.slot.keyFile": "eine Schlüsseldatei auf diesem Computer",
      "settings.credentials.moveToKeychain": "In den Systemschlüsselbund verschieben",
      "settings.credentials.keyFileExplainer":
        "Der Schlüssel, der deinen Tresor öffnet, ist eine Datei, die nur dein Account lesen kann. Ihn in den Systemschlüsselbund zu verschieben, braucht den Linux-Helfer; der Helfer dieses Builds ist nicht verfügbar.",
      "settings.credentials.link.err.locked":
        "Der Tresor ist gesperrt. Entsperre ihn mit deinem Passwort und verknüpfe {name} dann erneut.",
      "settings.approval.presenceUnavailable":
        "Dieses Fenster kann nicht bestätigen, dass du es bist. Genehmige die Änderung in der Psyche-App auf deinem Computer (dein Passwort) oder auf einem Gerät mit Passkey. Bis dahin ändert sich nichts.",
      "settings.approval.promptDetail":
        "Sicherheitseinstellungen brauchen dein Passwort oder einen Passkey. Genehmige es hier oder in der Psyche-Mitteilung; die Einstellung wird gesichert, sobald sie genehmigt ist.",
      "settings.approval.presenceInvalid":
        "Dein Passwort oder der Passkey konnte nicht bestätigen, dass du es bist. Versuche es erneut.",
      "settings.about.revealHome": "In Dateien zeigen",
      "settings.uninstall.keychainStays":
        "Einträge im Systemschlüsselbund bleiben erhalten (der Tresorschlüssel und die Einträge des Helfers). Entferne sie bei Bedarf in deiner Schlüsselbund-App.",
      "settings.uninstall.keychainGoes":
        "Die Einträge im Systemschlüsselbund für den Tresor und den Helfer werden ebenfalls entfernt.",
      "settings.uninstall.removeKeychain":
        "Auch meine Einträge im Systemschlüsselbund entfernen (die für Psyche). Ohne deine Daten sind sie nutzlos.",
      "settings.uninstall.presence":
        "Danach wirst du gebeten, mit deinem Passwort oder auf diesem Gerät zu bestätigen, weil dabei deine Daten entfernt werden.",
      "settings.appearance.showInDockHint":
        "Aus läuft Psyche weiter im Infobereich, wenn das letzte Fenster geschlossen wird.",
      "settings.appearance.openAtLoginHint":
        "Startet Psyche beim Anmelden im Infobereich, damit geplante Automatisierungen immer laufen können.",
      "settings.browser.letTasksUseHint":
        "Jede Aufgabe fragt dich trotzdem zuerst, auf diesem Gerät mit deinem Passwort oder einem Passkey.",
      "settings.browser.detailsText":
        "Während eine Aufgabe es verwendet, führt Psyche Google Chrome mit diesem Profil und einem DevTools-Port auf dem Loopback dieses Computers (127.0.0.1) aus und schließt es, wenn die Aufgabe fertig ist. {persona} ist nicht verbunden, solange du das Profil selbst geöffnet hast.",
      "settings.browser.openFromMac":
        "Öffne es aus der Psyche-App auf dem Computer, auf dem das Gateway läuft.",
      "settings.channels.empty":
        "Noch keine Kanäle. Verbinde Telegram oder Slack, um {persona} auch fern von diesem Computer zu erreichen.",
      "settings.computerUse.description":
        "{persona} kann Apps auf diesem Computer nur dort verwenden, wo du es erlaubst.",
      "settings.computerUse.macPermissions": "Desktop-Berechtigungen",
      "settings.computerUse.openSystemSettingsFor": "Einstellungen für {name} öffnen",
      "settings.computerUse.openSystemSettings": "Einstellungen öffnen",
      "settings.trusted.loading": "Werden von diesem Computer gelesen …",
      "settings.trusted.noHelper":
        "Öffne Psyche auf deinem Computer, um sie aufzulisten: Der Helper liest sie.",
      "settings.trusted.failed": "Psyche konnte sie nicht von diesem Computer lesen.",
      "settings.mcp.sandboxHelp": "Befehlsserver brauchen eine Sandbox auf diesem Computer.",
      "settings.sandbox.why":
        "Befehle laufen auf deinem Computer mit deinen Dateien, können aber weder deinen Tresor, deine Schlüssel noch die privaten Daten von Psyche lesen.",
      "settings.sandbox.whyHow":
        "Nutzt srt, die Sandbox-Runtime von Anthropic, mit der eigenen Sandbox-Funktion von Linux (bubblewrap). Keine virtuelle Maschine nötig.",
      "settings.sandbox.checking": "Dieser Computer wird geprüft …",
      "settings.sandbox.containers.body":
        "Eine Container-Runtime führt Code in einer eigenen Linux-Maschine ohne Zugriff auf die Dateien deines Computers aus: für Code, den der Agent ausführt, und einige Dateikonvertierungen. Befehlsserver nutzen weiter srt, außer das Gateway ist auf Container eingestellt.",
      "settings.searchSources.description":
        "Was Psyche in deinen Suchindex einliest. Alles ist aus, bis du es einschaltest; der Index bleibt auf diesem Computer. Wer eine Quelle einschaltet, lässt auch das Gedächtnis daraus lernen, außer du widersprichst unter Gedächtnis → Quellen (Ausnahmen sind Gedächtnis und Kontakte: aus beiden wird nicht gelernt).",
      "settings.searchSources.runOnBatteryHint":
        "Lässt Indexieren, „Neu aufbauen“ und das Lesen von Text in Bildern im Akkubetrieb weiterlaufen, in gemächlicherem Tempo. Das verbraucht mehr Akku. Der Energiesparmodus pausiert das Indexieren weiterhin.",
      "settings.searchSources.ocrHint":
        "Liest Screenshots und gescannte PDFs, Seite für Seite, am Netzbetrieb (oder im Akkubetrieb, wenn „Im Akkubetrieb indexieren“ an ist). Nichts verlässt deinen Computer.",
      "settings.semanticSearch.description":
        "Finde Dinge nach Bedeutung und nach ihren Wörtern, alles auf diesem Computer.",
      "settings.semanticSearch.engine.builtinHint":
        "Multilingual E5 small, etwa 100 Sprachen, läuft auf dem Prozessor dieses Computers.",
      "settings.semanticSearch.engine.routerHint":
        "Nutzt das unter „Rollen“ festgelegte Embedding-Modell, zum Beispiel Ollama oder LM Studio auf diesem Computer.",
      "settings.semanticSearch.allowCloudHint":
        "Nur wenn das Embedding-Modell ein Cloud-Dienst ist. Deine Chats, Aufgaben und der Text der Mediathek werden dorthin gesendet. Aus hält alles auf diesem Computer.",
      "settings.semanticSearch.state.cloudBlocked":
        "Das Embedding-Modell unter „Rollen“ ist ein Cloud-Dienst. Die semantische Suche nutzt nur Modelle auf diesem Computer.",
      "settings.data.encryptMemory.pending": "Wartet auf den Schlüssel vom Linux-Helper.",
      "settings.devices.touchId.none":
        "Noch kein Passwort-Schlüssel. Karten, die dein Passwort brauchen, lassen sich erst genehmigen, wenn einer registriert ist.",
      "settings.devices.touchId.noBundledKey":
        "Der Linux-Helfer in dieser App hat keinen Genehmigungsschlüssel ({reason}).",
      "settings.devices.touchId.manualHint":
        "Führe psyche-helper --print-identity auf dem Computer aus und füge die ausgegebene presenceKeyId ein.",
      "settings.devices.noNodes":
        "Keine Knoten. Der Linux-Helfer erscheint hier, sobald Psyche auf diesem Computer läuft.",
      "settings.files.execHost": "Befehle auf diesem Computer ausführen",
      "settings.files.execHostSwitch": "Befehle auf diesem Computer erlauben",
      "settings.model.ram.tooSmall":
        "Dieser Computer hat {gb, number} GB. Lokale Modelle brauchen mindestens {min, number} GB; verwende stattdessen einen Cloud-Anbieter.",
      "settings.model.ram.fits": "Dieser Computer hat {gb, number} GB, also passen {fits}.",
      "settings.model.ram.thisMac": " (dieser Computer)",
      "settings.model.localHint":
        "Führe Modelle auf diesem Computer mit Ollama oder LM Studio aus.",
      "settings.permissions.never.browserPasswords":
        "In Browsern oder im Systemschlüsselbund gespeicherte Passwörter lesen",
      "settings.server.bindHint":
        "127.0.0.1 hält es auf diesem Computer. Verwende unten den Fernzugriff, statt an jede Schnittstelle zu binden.",
      "settings.gateways.description":
        "Nutze Psyche von diesem Computer aus mit dem Gateway auf einem anderen, etwa deinem Computer zu Hause. Es ist immer ein Gateway aktiv, und das Wechseln startet Psyche neu.",
      "settings.gateways.thisMac": "Dieser Computer",
      "settings.gateways.switchKeep":
        "Psyche startet auf {name} neu. Psyche auf diesem Computer läuft weiter, daher laufen seine Automatisierungen weiter.",
      "settings.gateways.switchAndStop": "Wechseln und Psyche auf diesem Computer beenden",
      "settings.gateways.addHint":
        "Füge den Kopplungslink von dem Computer ein, auf dem Psyche läuft (Einstellungen, Server & Fernzugriff, Anderen Computer koppeln). Ohne Link gib seine Tailscale-Adresse ein, https://<host>.<tailnet>.ts.net; dieser Computer bittet dann um Kopplung, und der Besitzer genehmigt sie dort.",
      "settings.gateways.problem.link_malformed":
        "Dieser Kopplungslink ist beschädigt. Kopiere ihn erneut von dem Computer, der ihn erstellt hat.",
      "settings.gateways.problem.link_bad_field":
        "Dieser Kopplungslink ist beschädigt. Kopiere ihn erneut von dem Computer, der ihn erstellt hat.",
      "settings.gateways.problem.link_lan":
        "Dieser Kopplungslink gilt für einen Computer in deinem lokalen Netzwerk, enthält aber dessen Zertifikat nicht, daher wird er nicht verwendet. Erstelle auf diesem Computer einen neuen: Anderen Computer koppeln, Aus diesem Netzwerk.",
      "settings.remote.description":
        "Lass Psyche auf einem anderen Computer das Gateway dieses Computers über Tailscale nutzen. Das Gateway bleibt auf diesem Computer und lauscht nur darauf; Tailscale Serve ist der einzige Zugang.",
      "settings.remote.step1":
        "Installiere Tailscale auf diesem Computer und auf dem anderen Computer und melde beide im selben Tailnet an.",
      "settings.remote.step2":
        "Veröffentliche das Gateway in einem Terminal auf diesem Computer in deinem Tailnet. Das ist Serve, nicht Funnel.",
      "settings.remote.step4":
        "Starte Psyche neu. Füge dann auf dem anderen Computer diesen Computer als Gateway hinzu. Er zeigt einen Kopplungscode und einen Schlüssel-Fingerabdruck: Vergleiche sie mit der Anfrage unter „Wartet auf Kopplung“ hier und genehmige sie dann.",
      "settings.remote.admin":
        "Ein gekoppelter Computer erhält Lesen, Schreiben und Genehmigungen. Admin bleibt aus, außer du hakst es bei der Genehmigung an, und jede Admin-Änderung braucht hier weiterhin dein Passwort.",
      "settings.pair.needsAddress":
        "Lege zuerst die öffentliche Adresse dieses Computers fest (Schritt 3 oben) und erstelle dann einen Kopplungslink.",
      "settings.pair.adminHint":
        "Admin erlaubt ihm, Sicherheitseinstellungen, Geräte und den Tresor zu ändern, und bleibt aus, außer du hakst es an. Jede Admin-Änderung braucht hier weiterhin dein Passwort.",
      "settings.pair.compare":
        "Er prüft den Schlüssel dieses Computers, bevor er den Link nutzt: {fingerprint}. Du kannst vergleichen.",
      "settings.pair.secret":
        "Wer diesen Link in den nächsten zehn Minuten hat, kann einen Computer koppeln. Poste ihn nicht und sende ihn nicht an jemanden, dem du diesen Computer nicht anvertrauen würdest.",
      "settings.pair.err.noAddress":
        "Dieser Computer hat noch keine öffentliche Adresse, daher gibt es nichts, was in einen Link gehört.",
      "settings.pair.viaAddress": "Über Tailscale, unter der Adresse dieses Computers",
      "settings.pair.viaLanHint":
        "Ein Link für dieses Netzwerk enthält den Schlüssel und das Zertifikat dieses Computers und funktioniert daher nur für Computer im selben WLAN oder Ethernet.",
      "settings.pair.lanNote":
        "Dieser Link gilt für Computer im selben Netzwerk wie dieser Computer. Er nennt den Schlüssel und das Zertifikat, auf die Psyche besteht.",
      "settings.lan.description":
        "Lass Psyche auf einem anderen Computer im selben WLAN oder Ethernet das Gateway dieses Computers ohne Tailscale erreichen. Es ist aus, bis du es einschaltest.",
      "settings.lan.toggleHint":
        "Psyche lauscht in einem Netzwerk, über eine verschlüsselte Verbindung mit eigenem Zertifikat. Ein Computer, der sich verbindet, muss hier trotzdem per Passwort genehmigt werden.",
      "settings.lan.noInterface":
        "Auf diesem Computer wurde keine WLAN- oder Ethernet-Verbindung gefunden.",
      "settings.lan.notAdvertised":
        "Nicht angezeigt. Füge diesen Computer über seine Adresse hinzu.",
      "settings.lan.problem.unknownInterface": "{name} ist kein Netzwerk auf diesem Computer.",
      "settings.lan.problem.advertise":
        "Psyche konnte sich im Netzwerk nicht ankündigen. Computer können diesen Computer weiterhin über seine Adresse hinzufügen.",
      "settings.server.noVm":
        "Keine VM. Der VM-Modus führt Psyche in einem separaten Gastcomputer aus; richte ihn über die Einrichtung ein.",
      "settings.shortcut.key.Control": "Ctrl",
      "settings.shortcut.key.Alt": "Alt",
      "settings.skills.permission.exec_host": "Befehle auf diesem Computer ausführen",
      "settings.skills.permission.computer_action": "Apps auf diesem Computer verwenden",
      "settings.skills.pathPlaceholder": "/home/du/Downloads/pdf-merge",
      "settings.skills.signer.originAgent":
        "Von einem Assistenten auf dem Computer des Absenders geschrieben. Lies es als ungeprüften Text, egal wer signiert hat.",
      "settings.skills.export.hint":
        "Die Datei wird mit deinem Autorenschlüssel signiert, sodass Empfänger erkennen, dass sie von dir stammt und nicht verändert wurde. Der Schlüssel bleibt auf diesem Computer.",
      "settings.vm.phase.installing": "Gast wird eingerichtet",
      "settings.vm.description":
        "Aufgaben in einem separaten Sandbox-Computer ausführen, sodass {persona} in einer eigenen Kopie von Linux arbeitet statt in deiner.",
      "settings.vm.sandboxMac": "Sandbox-Computer",
      "settings.vm.between": "Zwischen deinem Computer und dem Gast",
      "settings.vm.credentialsHint":
        "Mit dem Tresor des Hosts bleiben Werte auf deinem Computer. Ein Gast-Tresor behält seine eigene Kopie.",
      "settings.vm.noReports":
        "Noch kein Gast hat sich gemeldet. Erstelle einen über den Psyche-Helfer auf diesem Computer; sein Zustand wird hier angezeigt.",
      "settings.voice.key.rightOption": "Rechte Alt-Taste",
      "settings.voice.key.rightCommand": "Rechte Ctrl-Taste",
      "settings.voice.reply.gatewayHint":
        "Die für die Persona festgelegte Stimme oder die Systemstimme.",
      "settings.voice.engine.local": "Auf diesem Computer",
      "settings.voice.engine.localHint": "Whisper läuft lokal; Audio verlässt den Computer nie.",
      "settings.voice.engine.system": "System-Diktat",
      "settings.voice.engine.systemHint":
        "Die Erkennung des Systems auf dem Gerät, über den Linux-Helfer.",
      "settings.voice.model.usingHelper":
        "Das Diktat nutzt die Spracherkennung des Helfers. Das Sprachmodell transkribiert besser und läuft auf diesem Computer.",
      "settings.voice.model.downloadHint":
        "Ein einmaliger Download vom Projekt whisper.cpp, der vor der Verwendung geprüft wird. Audio verlässt diesen Computer nie.",
      "settings.voice.model.ready": "Whisper ({model}) auf diesem Computer",
      "settings.voice.model.readyHint":
        "Diktat und Aufnahmen werden hier transkribiert; Audio verlässt den Computer nie.",
      "settings.connect.finishOpened":
        "Die Anmeldung bei {name} wurde im Browser auf dem Computer des Gateways geöffnet. Dies wird aktualisiert, wenn du fertig bist.",
      "settings.connect.needsPermission":
        "{name} ist eingerichtet, aber das System hat es noch nicht erlaubt. Erlaube es unter",
      "settings.connect.openSystemSettings": "Einstellungen öffnen",
      "settings.people.description":
        "Die Karten, die {persona} für die Personen und Projekte in deinem Leben führt. Sie bleiben auf diesem Computer, und jeder Fakt zeigt, woher er stammt.",
      "settings.about.versionsHint": "Was auf diesem Computer läuft.",
      "settings.computerUse.macPermissionsHint": "Was der Desktop erlaubt.",
      "settings.connectorBundle.sandbox.none":
        "Dieser Computer hat keine Sandbox für Befehls-Connectors, und Psyche führt nie einen außerhalb davon aus. Dieser Connector kann hier nicht installiert werden. Es wurde nichts gestartet oder gespeichert.",
      "settings.connectorBundle.share.unavailable":
        "Nur Psyche auf dem Computer, auf dem er läuft, kann einen Connector signieren.",
      "settings.deviceAccess.files.title": "Dateien auf diesem Computer",
      "settings.deviceAccess.terminal.hint":
        "{persona} kann Terminalbefehle auf diesem Computer ausführen, wenn unter Berechtigungen → Zugriff „Befehle auf diesem Computer ausführen“ an ist.",
      "settings.deviceAccess.terminal.where":
        "Befehle laufen auf deinem Computer, in den Ordnern, die du geteilt hast, und dürfen nur in einen Ordner schreiben, den du mit Lesen und Schreiben geteilt hast.",
      "settings.mcp.needs.title": "Was das auf deinem Computer braucht",
      "settings.mcp.needs.node.fix":
        "Läuft auf dem eigenen Node von Psyche; braucht npm auf diesem Computer. Installiere Node.js von nodejs.org oder über deine Paketverwaltung.",
      "settings.mcp.needs.uv.fix": "Ein Python-Server. Installiere uv von docs.astral.sh/uv.",
      "settings.mcp.fail.node_missing":
        "Installiere Node.js (nodejs.org oder über deine Paketverwaltung), damit npm auf diesem Computer vorhanden ist, und prüfe dann erneut.",
      "settings.mcp.fail.uv_missing":
        "Installiere uv (docs.astral.sh/uv) und prüfe den Server dann erneut.",
      "settings.mail.voice.learn.hint":
        "Wren liest nur, was du in gesendeter Mail selbst geschrieben hast, ohne zitierten Text oder Signaturen. Das Profil bleibt auf diesem Computer in mail/VOICE.md.",
      "settings.mail.voice.localModel.hint":
        "Entwürfe in deinem Stil verlassen diesen Computer nie.",
      "settings.mail.transcribe.endpoint.hint":
        "Optional. Ein OpenAI-kompatibler Server für /v1/audio/transcriptions (zum Beispiel whisper.cpp auf diesem Computer). Wird verwendet, wenn der Linux-Helfer keine Spracherkennung hat. Audio wird nur an diese Adresse gesendet: https oder http auf 127.0.0.1.",
      "onboarding.mail.voiceHint":
        "Liest nur, was du geschrieben hast, ohne zitierten Text oder Signaturen. Es bleibt auf diesem Computer, und du kannst es ansehen, bearbeiten oder zurücksetzen.",
      "gallery.preset.git.field.repo.help":
        "Der Ordner eines Git-Repositorys auf diesem Computer. Psyche kann seinen Verlauf und seine Diffs lesen.",
      "settings.connectors.page.onThisMac": "Auf diesem Computer",
      "settings.connectors.page.row.local": "Läuft auf diesem Computer",
      "settings.connectors.page.server.local":
        "Ein Tool, das in einer Sandbox auf diesem Computer läuft",
      "onboarding.permission.denied": "In den Einstellungen aus",
      "onboarding.permission.deniedHint":
        "Schalte es in den Einstellungen deines Systems ein; diese Seite wird aktualisiert, wenn du zurückkommst.",
      "onboarding.permission.unavailableHint":
        "Psyche kann das nur in der Psyche-Desktop-App anfragen.",
      "onboarding.connectors.onThisMac": "Auf diesem Computer",
      "onboarding.connectors.onThisMacHint":
        "Jede App bittet das System beim Verbinden einzeln um Erlaubnis.",
      "onboarding.model.kind.localHint": "Läuft auf diesem Computer; nichts verlässt ihn.",
      "onboarding.model.subscriptionNote":
        "Psyche verwendet die auf diesem Computer bereits angemeldete Claude-Code- oder Codex-App, braucht also keinen API-Schlüssel und speichert keinen. Melde dich zuerst dort an, falls noch nicht geschehen.",
      "onboarding.safety.touchId": "Dein Passwort für Genehmigungen",
      "onboarding.safety.touchId.checking": "Der Linux-Helper wird geprüft …",
      "onboarding.safety.touchId.setHint":
        "Genehmigungen, die dich brauchen, verlangen dein Passwort.",
      "onboarding.safety.touchId.starting": "Der Linux-Helper startet noch. Prüfe gleich erneut.",
      "onboarding.safety.touchId.noKey":
        "Der Linux-Helper hat keinen Genehmigungsschlüssel ({reason}).",
      "onboarding.safety.touchId.hint":
        "Registriere den Schlüssel des Linux-Helpers einmal, damit dein Passwort Genehmigungen bestätigen kann.",
      "onboarding.safety.asks":
        "Erlaubst du {name}, Befehle auf diesem Computer auszuführen, laufen solche, die nur lesen, wie ls oder cat, ohne Karte. Alles andere fragt dich zuerst.",
      "onboarding.done.touchId": "Dein Passwort",
      "onboarding.done.try.search":
        "Stelle in der Suche (Ctrl+K) eine Frage. Die Antwort zeigt, woher in deinem Leben sie stammt.",
      "screens.search.source.revealFile": "In Dateien zeigen",
      "everything.model.localHint":
        "Ein Modell auf diesem Computer liest alles. Nichts verlässt den Computer. Weniger, unschärfere Fakten.",
      "everything.run.reason.battery":
        "Gerade nicht: Der Computer läuft im Akkubetrieb. Schließe ihn an oder erlaube Läufe im Akkubetrieb.",
      "everything.run.reason.thermal": "Gerade nicht: Der Computer ist zu warm.",
      "everything.run.reason.not_idle": "Gerade nicht: Du benutzt den Computer.",
      "everything.storage.note": "Alles wird nur auf diesem Computer gespeichert.",
      "memoryWork.consent.k1":
        "Nichts verlässt diesen Computer. Daten und Status werden per Code ermittelt.",
      "screens.library.reveal": "In Dateien zeigen",
      "web.zoom.description":
        "Wie groß die App auf diesem Computer dargestellt wird. Ctrl+Plus und Ctrl+Minus ändern dieselbe Einstellung, sodass sie einen Neustart überdauert; {min, number}–{max, number} %.",
      "web.transcriptMode.optionTitle": "{mode} (Ctrl+O schaltet durch)",
      "web.backups.restore": "Auf einem neuen Computer bei gestopptem Gateway wiederherstellen:",
      "web.passkeys.firstApproval":
        "Genehmige „Passkey hinzufügen“ mit deinem Passwort auf deinem Computer oder mit einem Passkey auf einem anderen Gerät und drücke dann erneut „Hinzufügen“.",
      "web.passkeys.added":
        "{name} hinzugefügt. Er genehmigt jetzt Änderungen, die dein Passwort oder einen Passkey brauchen.",
      "web.remotePresence.title": "Dein Passwort für Genehmigungen",
      "web.remotePresence.description":
        "Käufe, Passwort-Eingaben, Host-Befehle und Sicherheitsänderungen brauchen dein Passwort oder einen Passkey. Richte es auf diesem Computer ein, um sie hier zu beantworten; bis dahin sagen diese Karten, dass du auf {host} antworten sollst. Normale Genehmigungen brauchen es nie.",
      "web.remotePresence.on": "Passwort-Genehmigungen sind für diesen Computer an.",
      "web.remotePresence.off":
        "Passwort-Genehmigungen sind auf diesem Computer nicht eingerichtet.",
      "web.remotePresence.enable": "Dein Passwort für Genehmigungen auf diesem Computer verwenden",
      "web.remotePresence.waiting": "Warten auf dein Passwort …",
      "web.remotePresence.passkeyName": "Dein Passwort auf diesem Computer",
      "web.remotePresence.enabled": "Passwort-Genehmigungen sind für diesen Computer an.",
      "web.remotePresence.disabled": "Passwort-Genehmigungen sind auf diesem Computer aus.",
      "web.remotePresence.approveOnHost":
        "Genehmige „Passkey hinzufügen“ auf {host} mit dessen Touch ID, Windows Hello oder Passwort oder mit einem Passkey und drücke dann die Schaltfläche erneut.",
      "web.remotePresence.unavailable":
        "Passwort-Genehmigungen brauchen das Gateway von {host} unter einer https://-Adresse (gateway.publicOrigin). Bis dahin beantworte diese Karten auf {host}.",
      "web.webauthn.noPasskeyYet":
        "Dieser Browser hat noch keinen Passkey. Füge einen unter „Einstellungen“ → „Geräte & Knoten“ hinzu oder genehmige auf dem Computer, auf dem das Gateway läuft.",
      "web.webauthn.needsOrigin":
        "Passkeys brauchen die https-Adresse des Servers (gateway.publicOrigin). Genehmige stattdessen auf dem Computer, auf dem das Gateway läuft.",
      "web.setup.gatewayOk": "Läuft auf diesem Computer.",
      "web.setup.adminOk": "Dieser Computer ist das Admin-Gerät.",
      "web.viewers.noSandbox":
        "Vorschauen von Folien brauchen die Sandbox, und es ist keine Container-Laufzeit (Docker oder Podman) verfügbar.",
      "web.voice.noEngine":
        "Keine Spracherkennung verfügbar. Installiere unter Einstellungen → Sprache ein Sprachmodell oder verbinde den Linux-Helfer.",
      "web.threads.newSideChatTitle": "Neuer Nebenchat (Ctrl+N)",
      "web.panes.closePaneTitle": "Bereich schließen (Ctrl+\\)",
      "web.chat.permissionModeTitle": "Berechtigungsmodus (Ctrl+Shift+M)",
      "web.chat.modelTitle": "Modell (Ctrl+Shift+I)",
      "web.splash.installing": "Psyche wird auf diesem Computer eingerichtet …",
      "web.splash.helper": "Psyche wird auf deinem Computer vorbereitet …",
      "web.splash.remote.useThisMac": "Diesen Computer verwenden",
      "web.remote.thisMac": "Dieser Computer",
      "web.teach.bar.body":
        "Psyche notiert deine Klicks und Eingaben nur in diesem Tab. Passwörter, Kartennummern und Codes werden nie aufgezeichnet, und nichts verlässt diesen Computer, bis du sicherst.",
      "settings.teach.storage.description":
        "Bittest du Psyche, eine Aufnahme zu behalten, damit du eine weitere Version erstellen kannst, werden die Schritte auf diesem Computer gesichert.",
      "settings.teach.storage.encrypted":
        "Verschlüsselt. Die Datei ist mit einem Schlüssel im Systemschlüsselbund gesperrt und lässt sich daher außerhalb von Psyche nicht lesen. Sie läuft nach 90 Tagen ab.",
      "settings.teach.storage.unavailable":
        "Aufnahmen werden nicht behalten. Der Systemschlüsselbund ist nicht verfügbar, und Psyche speichert eine Aufnahme nicht als Klartext. Du kannst eine Aufnahme weiterhin als Skill sichern.",
      "web.teach.review.keepUnavailable":
        "Nicht verfügbar: Der Systemschlüsselbund steht nicht zur Verfügung, um eine behaltene Aufnahme zu verschlüsseln.",
      "web.teach.review.keepRecording":
        "Diese Aufnahme auf diesem Computer behalten, damit ich eine weitere Version erstellen kann",
      "web.teach.app.recordHint":
        "Psyche zeigen, wie etwas in einer App geht, die du schon erlaubt hast",
      "web.teach.app.bar.body":
        "Psyche notiert deine Klicks, Menüauswahlen und Eingaben nur in {app}. Geschützte Felder werden nie aufgenommen, es werden keine Screenshots gemacht, und nichts verlässt diesen Computer, bis du speicherst. Im Infobereich gibt es außerdem ein Stopp.",
      "voice.key.rightOption": "Alt rechts",
      "voice.key.rightCommand": "Ctrl rechts",
      "voice.settings.reviewHint":
        "Behält, was Psyche gehört hat, im Pop-up, damit du es korrigieren und mit Enter senden kannst. Aus: Es wird gesendet, sobald du die Taste loslässt.",
      "meetingRecord.unavailable":
        "Zum Aufnehmen braucht es eine Möglichkeit, Audio in Notizen umzuwandeln (ein Sprachmodell oder den Linux-Helfer), und keines davon ist verbunden.",
      "meetingRecord.micDenied":
        "Psyche kann das Mikrofon nicht nutzen. Erlaube es in den Einstellungen deines Systems.",
      "platform.term.os": "Linux",
      "platform.term.device": "Computer",
      "platform.term.thisDevice": "Dieser Computer",
      "platform.term.thisDeviceLower": "dieser Computer",
      "platform.term.presence": "dein Passwort",
      "platform.term.secretStore": "Systemschlüsselbund",
      "platform.term.systemSettings": "Einstellungen",
      "platform.term.fileManager": "Dateien",
      "platform.term.trayArea": "Infobereich",
      "platform.term.taskbar": "Taskleiste",
      "platform.term.systemSearch": "Desktop-Suche",
      "platform.term.helper": "Linux-Helfer",
      "platform.term.terminal": "Terminal",
      "platform.term.alt": "Alt",
      "platform.term.mod": "Ctrl",
      "web.security.banner.recovery":
        "{count, plural, one {Eine auf diesem Computer angeforderte Sicherheitsänderung gilt ab {when}, wenn du sie nicht abbrichst.} other {# auf diesem Computer angeforderte Sicherheitsänderungen warten. Die nächste gilt ab {when}.}}",
      "web.security.alert.changed":
        "Ein Programm auf diesem Computer hat {count, plural, one {1 Sicherheitseintrag} other {# Sicherheitseinträge}} an Psyche vorbei geändert. Psyche hat {count, plural, one {ihn} other {sie}} wiederhergestellt. Wenn du das nicht warst, prüfe den Computer auf unerwünschte Software.",
      "web.security.alert.untrusted":
        "Die Prüfung von Psyches Sicherheitsdaten ist fehlgeschlagen. Neue Geräte, Sicherheitseinstellungen und Passwort-Freigaben sind gesperrt. Prüfe deine Geräte und führe dann auf dem Computer psyched security reseal aus; das gilt nach 24 Stunden.",
      "web.security.alert.firstAdmin":
        "Ein Befehl auf diesem Computer hat {name} zum ersten Admin-Gerät gemacht. Wenn du das nicht warst, widerrufe es unter Geräte.",
      "web.security.alert.requested": "Auf diesem Computer angefordert: {action} Gilt ab {when}.",
      "web.security.op.presenceReset":
        "für Sicherheitsänderungen weder dein Passwort noch einen Passkey mehr verlangen, bis ein neuer Schlüssel registriert ist.",
      "web.security.needsApproval":
        "Bestätige die Karte mit deinem Passwort oder einem Passkey und tippe dann erneut auf die Taste.",
    },
    es: {
      "settings.devices.nodeKind.hostHelper": "Asistente de Linux",
      "settings.links.description":
        "Dónde se abre un enlace de un mensaje, tarjeta o artefacto. Ctrl+clic siempre usa tu navegador predeterminado.",
      "errors.presence_required":
        "Confirma primero que eres tú con tu contraseña o una llave de acceso.",
      "chat.toolbar.keySheet": "Ctrl+Shift+A",
      "chat.toolbar.keyModel": "Ctrl+Shift+I",
      "chat.toolbar.keyView": "Ctrl+O",
      "chat.approval.keysHint": "Ctrl+Enter {allows} · Ctrl+D {denies}",
      "blocks.details.runsOnHost": "en tu ordenador, fuera del entorno aislado",
      "blocks.details.runsSandboxed":
        "en tu ordenador, en el entorno aislado: no puede leer la bóveda de Psyche, tus claves SSH, el llavero del sistema ni los perfiles del navegador",
      "blocks.details.runsNoSandbox":
        "en tu ordenador, y el entorno aislado no está configurado ({reason})",
      "blocks.permission.need.capability": "Activa «Ejecutar comandos en este ordenador»",
      "blocks.permission.need.macos_access": "Da acceso a {connector} en Configuración",
      "blocks.permission.openSystemSettings": "Abrir Configuración",
      "blocks.approval.answerOnHost":
        "Responde en {host}, o configura las aprobaciones con contraseña para este ordenador en Ajustes → Dispositivos.",
      "blocks.approval.needsAuth": "Hace falta tu contraseña o una llave de acceso para aprobar.",
      "blocks.approval.touchIdFailed":
        "Falló la comprobación de la contraseña: {reason}. Inténtalo de nuevo.",
      "blocks.approval.touchIdFailedNoReason":
        "Falló la comprobación de la contraseña. Inténtalo de nuevo.",
      "blocks.approval.touchId.helperOffline":
        "El asistente de Linux no se está ejecutando, así que tu contraseña no puede confirmarlo aquí.",
      "blocks.approval.touchId.noKey":
        "Las aprobaciones con contraseña aún no están configuradas en este ordenador. Configúralas en Ajustes → Dispositivos, donde puedes comprobar antes la clave.",
      "blocks.approval.touchId.invalidated":
        "Tu configuración de contraseña cambió desde que se configuró la clave de este ordenador, así que no puede confirmar aprobaciones. Vuelve a configurarla en Ajustes → Dispositivos.",
      "blocks.approval.touchId.noUnsandboxed":
        "Ejecutar un comando sin el entorno aislado no se puede aprobar con tu contraseña desde esta ventana. Configura el entorno aislado en su lugar",
      "blocks.approval.touchId.onceOnly":
        "las aprobaciones con contraseña desde esta ventana son de una sola vez.",
      "blocks.approval.status.allowedOnceTouchId":
        "Permitido una vez (las aprobaciones con contraseña desde esta ventana son de una sola vez)",
      "blocks.approval.touchId.keyUnavailable":
        "Esta versión del asistente de Linux no puede guardar una clave de aprobación, así que las tarjetas que necesitan tu contraseña no se pueden aprobar en este ordenador.",
      "blocks.approval.touchId.cancelled":
        "Se canceló la solicitud de contraseña, así que no se aprobó nada",
      "shell.shortcut.pushToTalkKeys": "Mantén pulsada Ctrl derecha",
      "settings.shared.needsPresence":
        "Cambiar «{label}» necesita tu aprobación con tu contraseña o una llave de acceso. Apruébalo en Ajustes o en la notificación de Psyche y vuelve a cambiarlo.",
      "settings.page.permissions.description":
        "Lo que {persona} puede hacer en este ordenador sin preguntar, y dónde se detiene siempre a preguntarte.",
      "settings.page.data.description":
        "Lo que se queda en este ordenador, cuánto tiempo se conserva, exportaciones, copias de seguridad y empezar de cero.",
      "settings.essentials.model.noneHint":
        "{persona} necesita un modelo para poder responder. Añade una clave o usa un modelo de este ordenador.",
      "settings.essentials.read.hint":
        "Desactivado hasta que actives alguno. Lo que lee se indexa en este ordenador para poder encontrar cosas por ti, y la memoria también aprende de ello salvo que lo excluyas en Memoria → Fuentes.",
      "settings.searchModel.apple.notOnThisMac": "Disponible en macOS",
      "settings.macHelper.paired.text":
        "Se encarga del uso del ordenador, el contexto de pantalla, el dictado, las aprobaciones con contraseña y las notificaciones en este ordenador.",
      "settings.macHelper.unbundled.text":
        "Esta compilación de Psyche no incluye el asistente para Linux.",
      "settings.key.appearance.showInDock":
        "Mostrar en la barra de tareas cuando no hay ventanas abiertas",
      "settings.semanticSearch.encrypt.pending":
        "Esperando a que el asistente de Linux abra el índice cifrado",
      "settings.semanticSearch.rerankHint":
        "Un modelo pequeño en la nube pone los mejores resultados primero. Los 20 fragmentos principales salen de este ordenador. Desactivado por defecto.",
      "settings.key.vm.enabled": "Usar un ordenador aislado para las tareas",
      "settings.key.vm.resetPerTask": "Ordenador nuevo para cada tarea",
      "settings.credentials.backend.psyche": "Bóveda de Psyche (tu contraseña)",
      "settings.credentials.backend.keychain": "Llavero del sistema",
      "settings.credentials.backendIn.keychain": "en el llavero del sistema",
      "settings.credentials.err.lockedChange":
        "La bóveda está bloqueada. Desbloquéala con tu contraseña y vuelve a {verb, select, delete {eliminar} other {cambiar}} {name}.",
      "settings.credentials.err.lockedImport":
        "La bóveda está bloqueada. Desbloquéala con tu contraseña y vuelve a importar.",
      "settings.credentials.slot.keychain": "el llavero del sistema (tu contraseña)",
      "settings.credentials.slot.safeStorage": "el almacenamiento de apps de este ordenador",
      "settings.credentials.slot.keyFile": "un archivo de clave en este ordenador",
      "settings.credentials.moveToKeychain": "Mover al llavero del sistema",
      "settings.credentials.keyFileExplainer":
        "La clave que abre tu bóveda es un archivo que solo tu cuenta puede leer. Moverla al llavero del sistema necesita el asistente de Linux; el asistente de esta compilación no está disponible.",
      "settings.credentials.link.err.locked":
        "La bóveda está bloqueada. Desbloquéala con tu contraseña y vuelve a enlazar {name}.",
      "settings.approval.presenceUnavailable":
        "Esta ventana no puede confirmar que eres tú. Aprueba el cambio en la app Psyche de tu ordenador (tu contraseña) o desde un dispositivo con llave de acceso. No cambia nada hasta entonces.",
      "settings.approval.promptDetail":
        "Los ajustes de seguridad necesitan tu contraseña o una llave de acceso. Apruébalo aquí o en la notificación de Psyche; el ajuste se guarda en cuanto se aprueba.",
      "settings.approval.presenceInvalid":
        "Tu contraseña o la llave de acceso no confirmaron que eres tú. Inténtalo de nuevo.",
      "settings.about.revealHome": "Mostrar en Archivos",
      "settings.uninstall.keychainStays":
        "Los elementos del llavero del sistema se quedan (la clave de la bóveda y los del asistente). Elimínalos en tu aplicación de llaveros si quieres.",
      "settings.uninstall.keychainGoes":
        "También se eliminan los elementos del llavero del sistema de la bóveda y del asistente.",
      "settings.uninstall.removeKeychain":
        "Eliminar también mis elementos del llavero del sistema (los de Psyche). Sin tus datos no sirven de nada.",
      "settings.uninstall.presence":
        "Después se te pedirá que confirmes con tu contraseña o en este dispositivo, porque esto elimina tus datos.",
      "settings.appearance.showInDockHint":
        "Desactivado, Psyche sigue ejecutándose en la bandeja del sistema cuando se cierra su última ventana.",
      "settings.appearance.openAtLoginHint":
        "Inicia Psyche en la bandeja del sistema cuando inicias sesión, para que las automatizaciones programadas siempre puedan ejecutarse.",
      "settings.browser.letTasksUseHint":
        "Cada tarea sigue preguntándote primero, en este dispositivo con tu contraseña o una llave de acceso.",
      "settings.browser.detailsText":
        "Mientras una tarea lo usa, Psyche ejecuta Google Chrome con este perfil y un puerto de DevTools en el loopback de este ordenador (127.0.0.1), y lo cierra cuando la tarea termina. {persona} no está conectado mientras tengas el perfil abierto tú.",
      "settings.browser.openFromMac":
        "Ábrelo desde la app Psyche en el ordenador que ejecuta el Gateway.",
      "settings.channels.empty":
        "Aún no hay canales. Conecta Telegram o Slack para contactar con {persona} lejos de este ordenador.",
      "settings.computerUse.description":
        "{persona} solo puede usar las apps de este ordenador donde tú lo permitas.",
      "settings.computerUse.macPermissions": "Permisos del escritorio",
      "settings.computerUse.openSystemSettingsFor": "Abrir Configuración para {name}",
      "settings.computerUse.openSystemSettings": "Abrir Configuración",
      "settings.trusted.loading": "Leyéndolos de este ordenador…",
      "settings.trusted.noHelper": "Abre Psyche en tu ordenador para verlos: el asistente los lee.",
      "settings.trusted.failed": "Psyche no pudo leerlos de este ordenador.",
      "settings.mcp.sandboxHelp":
        "Los servidores de comandos necesitan un entorno aislado en este ordenador.",
      "settings.sandbox.why":
        "Los comandos se ejecutan en tu ordenador con tus archivos, pero no pueden leer tu bóveda, tus claves ni los datos privados de Psyche.",
      "settings.sandbox.whyHow":
        "Usa srt, el runtime de aislamiento de Anthropic, con el propio aislamiento de Linux (bubblewrap). No hace falta máquina virtual.",
      "settings.sandbox.checking": "Examinando este ordenador…",
      "settings.sandbox.containers.body":
        "Un runtime de contenedores ejecuta el código en su propia máquina Linux, sin acceso a los archivos de tu ordenador: para el código que ejecuta el agente y algunas conversiones de archivos. Los servidores de comandos siguen usando srt salvo que el Gateway esté configurado para usar contenedores.",
      "settings.searchSources.description":
        "Lo que Psyche lee para tu índice de búsqueda. Todo está desactivado hasta que lo actives; el índice se queda en este ordenador. Activar una fuente también deja que la memoria aprenda de ella, salvo que lo excluyas en Memoria → Fuentes (Memoria y Contactos son la excepción: de ninguna se aprende).",
      "settings.searchSources.runOnBatteryHint":
        "Permite que la indexación, Reconstruir y la lectura de texto en imágenes continúen mientras tu ordenador funciona con batería, a un ritmo más suave. Gasta más batería. El ahorro de energía sigue pausando la indexación.",
      "settings.searchSources.ocrHint":
        "Lee capturas de pantalla y PDF escaneados, una página a la vez, con corriente (o con batería si «Indexar con batería» está activado). Nada sale de tu ordenador.",
      "settings.semanticSearch.description":
        "Encuentra cosas por su significado además de por sus palabras, todo en este ordenador.",
      "settings.semanticSearch.engine.builtinHint":
        "Multilingual E5 small, unos 100 idiomas, se ejecuta en el procesador de este ordenador.",
      "settings.semanticSearch.engine.routerHint":
        "Usa el modelo de embeddings definido en Roles, por ejemplo Ollama o LM Studio en este ordenador.",
      "settings.semanticSearch.allowCloudHint":
        "Solo si el modelo de embeddings es un servicio en la nube. Se le envían tus chats, tareas y el texto de la Biblioteca. Desactivado mantiene todo en este ordenador.",
      "settings.semanticSearch.state.cloudBlocked":
        "El modelo de embeddings de Roles es un servicio en la nube. La búsqueda semántica solo usa modelos de este ordenador.",
      "settings.data.encryptMemory.pending": "Esperando la clave del asistente de Linux.",
      "settings.devices.touchId.none":
        "Aún no hay ninguna clave de contraseña. Las tarjetas que necesitan tu contraseña no se pueden aprobar hasta que se registre una.",
      "settings.devices.touchId.noBundledKey":
        "El asistente de Linux de esta app no tiene clave de aprobación ({reason}).",
      "settings.devices.touchId.manualHint":
        "Ejecuta psyche-helper --print-identity en el ordenador y pega el presenceKeyId que imprime.",
      "settings.devices.noNodes":
        "No hay nodos. El asistente de Linux aparece aquí en cuanto Psyche se ejecuta en este ordenador.",
      "settings.files.execHost": "Ejecutar comandos en este ordenador",
      "settings.files.execHostSwitch": "Permitir comandos en este ordenador",
      "settings.model.ram.tooSmall":
        "Este ordenador tiene {gb, number} GB. Los modelos locales necesitan al menos {min, number} GB; usa un proveedor en la nube.",
      "settings.model.ram.fits": "Este ordenador tiene {gb, number} GB, así que caben {fits}.",
      "settings.model.ram.thisMac": " (este ordenador)",
      "settings.model.localHint": "Ejecuta modelos en este ordenador con Ollama o LM Studio.",
      "settings.permissions.never.browserPasswords":
        "Leer las contraseñas guardadas en tus navegadores o en el llavero del sistema",
      "settings.server.bindHint":
        "127.0.0.1 lo mantiene en este ordenador. Usa el acceso remoto de abajo en vez de escuchar en todas las interfaces.",
      "settings.gateways.description":
        "Usa Psyche desde este ordenador con el Gateway de otro, como tu ordenador de casa. Solo hay un Gateway activo a la vez, y cambiar reinicia Psyche.",
      "settings.gateways.thisMac": "Este ordenador",
      "settings.gateways.switchKeep":
        "Psyche se reinicia en {name}. Psyche en este ordenador sigue ejecutándose, así que sus automatizaciones continúan.",
      "settings.gateways.switchAndStop": "Cambiar y detener Psyche en este ordenador",
      "settings.gateways.addHint":
        "Pega el enlace de vinculación del ordenador que ejecuta Psyche (Ajustes, Servidor y acceso remoto, Vincular otro ordenador). Sin enlace, escribe su dirección de Tailscale, https://<host>.<tailnet>.ts.net; este ordenador pedirá vincularse y el propietario lo aprueba allí.",
      "settings.gateways.problem.link_malformed":
        "Ese enlace de vinculación está dañado. Cópialo de nuevo desde el ordenador que lo creó.",
      "settings.gateways.problem.link_bad_field":
        "Ese enlace de vinculación está dañado. Cópialo de nuevo desde el ordenador que lo creó.",
      "settings.gateways.problem.link_lan":
        "Este enlace de vinculación es de un ordenador de tu red local pero no incluye su certificado, así que no se usa. En ese ordenador, crea uno nuevo: Vincular otro ordenador, Desde esta red.",
      "settings.remote.description":
        "Deja que Psyche en otro ordenador use el Gateway de este ordenador a través de Tailscale. El Gateway se queda en este ordenador y solo escucha a Tailscale; Tailscale Serve es la única entrada.",
      "settings.remote.step1":
        "Instala Tailscale en este ordenador y en el otro ordenador, e inicia sesión en ambos en la misma tailnet.",
      "settings.remote.step2":
        "En una terminal de este ordenador, publica el Gateway en tu tailnet. Es Serve, no Funnel.",
      "settings.remote.step4":
        "Reinicia Psyche. Luego, en el otro ordenador, añade este ordenador como Gateway. Mostrará un código de vinculación y la huella de una clave: compáralos con la solicitud en «Esperando vinculación» aquí y apruébala.",
      "settings.remote.admin":
        "Un ordenador que se vincula obtiene lectura, escritura y aprobaciones. Admin sigue desactivado salvo que lo marques al aprobar, y cada cambio de admin sigue necesitando tu contraseña aquí.",
      "settings.pair.needsAddress":
        "Define primero la dirección pública de este ordenador (paso 3 de arriba) y luego crea un enlace de vinculación.",
      "settings.pair.adminHint":
        "Admin le permite cambiar ajustes de seguridad, dispositivos y la bóveda, y sigue desactivado salvo que lo marques. Cada cambio de admin sigue necesitando tu contraseña aquí.",
      "settings.pair.compare":
        "Comprueba la clave de este ordenador antes de usar el enlace: {fingerprint}. Puedes compararla.",
      "settings.pair.secret":
        "Quien tenga este enlace en los próximos diez minutos puede vincular un ordenador. No lo publiques ni lo envíes a nadie en quien no confiarías para este ordenador.",
      "settings.pair.err.noAddress":
        "Este ordenador aún no tiene dirección pública, así que no hay nada que poner en un enlace.",
      "settings.pair.viaAddress": "Por Tailscale, en la dirección de este ordenador",
      "settings.pair.viaLanHint":
        "Un enlace para esta red contiene la clave y el certificado de este ordenador, así que solo funciona para ordenadores en el mismo Wi-Fi o Ethernet.",
      "settings.pair.lanNote":
        "Este enlace es para ordenadores de la misma red que este ordenador. Indica la clave y el certificado que Psyche exigirá.",
      "settings.lan.description":
        "Deja que Psyche en otro ordenador del mismo Wi-Fi o Ethernet acceda al Gateway de este ordenador, sin Tailscale. Está desactivado hasta que lo actives.",
      "settings.lan.toggleHint":
        "Psyche escucha en una red, mediante una conexión cifrada con su propio certificado. Un ordenador que se conecta sigue necesitando aprobación aquí con tu contraseña.",
      "settings.lan.noInterface":
        "No se encontró ninguna conexión Wi-Fi ni Ethernet en este ordenador.",
      "settings.lan.notAdvertised": "No visible. Añade este ordenador por su dirección.",
      "settings.lan.problem.unknownInterface": "{name} no es una red de este ordenador.",
      "settings.lan.problem.advertise":
        "Psyche no pudo anunciarse en la red. Los ordenadores aún pueden añadir este ordenador por su dirección.",
      "settings.server.noVm":
        "No hay VM. El modo VM ejecuta Psyche dentro de un ordenador invitado aparte; configúralo desde la configuración inicial.",
      "settings.shortcut.key.Control": "Ctrl",
      "settings.shortcut.key.Alt": "Alt",
      "settings.skills.permission.exec_host": "Ejecutar comandos en este ordenador",
      "settings.skills.permission.computer_action": "Usar apps en este ordenador",
      "settings.skills.pathPlaceholder": "/home/tú/Downloads/pdf-merge",
      "settings.skills.signer.originAgent":
        "Escrito por un asistente en el ordenador del remitente. Léelo como texto sin revisar, lo haya firmado quien lo haya firmado.",
      "settings.skills.export.hint":
        "El archivo se firma con tu clave de autor, para que quien lo reciba sepa que es tuyo y que no se modificó. La clave se queda en este ordenador.",
      "settings.vm.phase.installing": "Configurando el invitado",
      "settings.vm.description":
        "Ejecuta las tareas en un ordenador aislado aparte, de modo que {persona} trabaje en su propia copia de Linux y no en la tuya.",
      "settings.vm.sandboxMac": "Ordenador aislado",
      "settings.vm.between": "Entre tu ordenador y el invitado",
      "settings.vm.credentialsHint":
        "Con la bóveda del anfitrión, los valores se quedan en tu ordenador. Una bóveda del invitado guarda su propia copia.",
      "settings.vm.noReports":
        "Ningún invitado ha informado aún. Crea uno desde el asistente de Psyche en este ordenador; su estado se muestra aquí.",
      "settings.voice.key.rightOption": "Alt derecha",
      "settings.voice.key.rightCommand": "Ctrl derecha",
      "settings.voice.reply.gatewayHint":
        "La voz definida para la personalidad, o la voz del sistema.",
      "settings.voice.engine.local": "En este ordenador",
      "settings.voice.engine.localHint":
        "Whisper se ejecuta en local; el audio nunca sale del ordenador.",
      "settings.voice.engine.system": "Dictado del sistema",
      "settings.voice.engine.systemHint":
        "El reconocedor del sistema en el dispositivo, a través del asistente de Linux.",
      "settings.voice.model.usingHelper":
        "El dictado usa el reconocimiento de voz del asistente. El modelo de voz transcribe mejor y se ejecuta en este ordenador.",
      "settings.voice.model.downloadHint":
        "Una descarga única del proyecto whisper.cpp, que se verifica antes de usarla. El audio nunca sale de este ordenador.",
      "settings.voice.model.ready": "Whisper ({model}) en este ordenador",
      "settings.voice.model.readyHint":
        "El dictado y las grabaciones se transcriben aquí; el audio nunca sale del ordenador.",
      "settings.connect.finishOpened":
        "El inicio de sesión en {name} se abrió en el navegador del ordenador del Gateway. Esto se actualiza cuando acabes.",
      "settings.connect.needsPermission":
        "{name} está configurado, pero el sistema aún no lo ha permitido. Permítelo en",
      "settings.connect.openSystemSettings": "Abrir Configuración",
      "settings.people.description":
        "Las fichas que {persona} guarda de las personas y proyectos de tu vida. Se quedan en este ordenador y cada dato muestra de dónde viene.",
      "settings.about.versionsHint": "Lo que se está ejecutando en este ordenador.",
      "settings.computerUse.macPermissionsHint": "Lo que el escritorio permite.",
      "settings.connectorBundle.sandbox.none":
        "Este ordenador no tiene un entorno aislado para conectores de comando, y Psyche nunca ejecuta uno fuera de él. Este conector no se puede instalar aquí. No se inició ni se guardó nada.",
      "settings.connectorBundle.share.unavailable":
        "Solo Psyche en el ordenador que lo ejecuta puede firmar un conector.",
      "settings.deviceAccess.files.title": "Archivos en este ordenador",
      "settings.deviceAccess.terminal.hint":
        "{persona} puede ejecutar comandos de terminal en este ordenador cuando «Ejecutar comandos en este ordenador» está activado en Permisos → Acceso.",
      "settings.deviceAccess.terminal.where":
        "Los comandos se ejecutan en tu ordenador, en las carpetas que compartiste, y solo pueden escribir en una carpeta compartida con lectura y escritura.",
      "settings.mcp.needs.title": "Lo que esto necesita en tu ordenador",
      "settings.mcp.needs.node.fix":
        "Se ejecuta con el Node propio de Psyche; necesita npm en este ordenador. Instala Node.js desde nodejs.org o con tu gestor de paquetes.",
      "settings.mcp.needs.uv.fix": "Un servidor de Python. Instala uv desde docs.astral.sh/uv.",
      "settings.mcp.fail.node_missing":
        "Instala Node.js (nodejs.org, o tu gestor de paquetes) para que npm esté en este ordenador y vuelve a comprobar.",
      "settings.mcp.fail.uv_missing":
        "Instala uv (docs.astral.sh/uv) y vuelve a comprobar el servidor.",
      "settings.mail.voice.learn.hint":
        "Wren solo lee lo que escribiste en el correo enviado, sin el texto citado ni las firmas. El perfil se queda en este ordenador, en mail/VOICE.md.",
      "settings.mail.voice.localModel.hint":
        "Los borradores con tu estilo nunca salen de este ordenador.",
      "settings.mail.transcribe.endpoint.hint":
        "Opcional. Un servidor compatible con OpenAI para /v1/audio/transcriptions (por ejemplo, whisper.cpp en este ordenador). Se usa cuando el asistente de Linux no tiene motor de voz. El audio solo se envía a esta dirección: https, o http en 127.0.0.1.",
      "onboarding.mail.voiceHint":
        "Solo lee lo que escribiste, sin el texto citado ni las firmas. Se queda en este ordenador y puedes verlo, editarlo o restablecerlo.",
      "gallery.preset.git.field.repo.help":
        "La carpeta de un repositorio Git en este ordenador. Psyche puede leer su historial y sus diferencias.",
      "settings.connectors.page.onThisMac": "En este ordenador",
      "settings.connectors.page.row.local": "Se ejecuta en este ordenador",
      "settings.connectors.page.server.local":
        "Una herramienta que se ejecuta en un entorno aislado en este ordenador",
      "onboarding.permission.denied": "Desactivado en Configuración",
      "onboarding.permission.deniedHint":
        "Actívalo en la Configuración de tu sistema; esta página se actualiza cuando vuelvas.",
      "onboarding.permission.unavailableHint":
        "Psyche solo puede pedir esto desde la app de escritorio de Psyche.",
      "onboarding.connectors.onThisMac": "En este ordenador",
      "onboarding.connectors.onThisMacHint":
        "Cada app pide permiso al sistema al conectarse, una por una.",
      "onboarding.model.kind.localHint": "Se ejecuta en este ordenador; nada sale de él.",
      "onboarding.model.subscriptionNote":
        "Psyche usa la app Claude Code o Codex con la sesión ya iniciada en este ordenador, así que no necesita ninguna clave de API ni guarda ninguna. Si aún no lo has hecho, inicia sesión allí primero.",
      "onboarding.safety.touchId": "Tu contraseña para las aprobaciones",
      "onboarding.safety.touchId.checking": "Examinando el asistente de Linux…",
      "onboarding.safety.touchId.setHint": "Las aprobaciones que te necesitan piden tu contraseña.",
      "onboarding.safety.touchId.starting":
        "El asistente de Linux aún se está iniciando. Vuelve a comprobar en un momento.",
      "onboarding.safety.touchId.noKey":
        "El asistente de Linux no tiene clave de aprobación ({reason}).",
      "onboarding.safety.touchId.hint":
        "Registra una vez la clave del asistente de Linux para que tu contraseña pueda confirmar las aprobaciones.",
      "onboarding.safety.asks":
        "Si dejas que {name} ejecute comandos en este ordenador, los que solo leen, como ls o cat, se ejecutan sin tarjeta. Todo lo demás te pregunta antes.",
      "onboarding.done.touchId": "Tu contraseña",
      "onboarding.done.try.search":
        "Haz una pregunta en Buscar (Ctrl+K). La respuesta muestra de dónde en tu vida viene.",
      "screens.search.source.revealFile": "Mostrar en Archivos",
      "everything.model.localHint":
        "Un modelo de este ordenador lo lee todo. Nada sale del ordenador. Menos datos y más ruido.",
      "everything.run.reason.battery":
        "Ahora no: el ordenador funciona con batería. Conéctalo o permite ejecuciones con batería.",
      "everything.run.reason.thermal": "Ahora no: el ordenador está demasiado caliente.",
      "everything.run.reason.not_idle": "Ahora no: estás usando el ordenador.",
      "everything.storage.note": "Todo se guarda solo en este ordenador.",
      "memoryWork.consent.k1":
        "Nada sale de este ordenador. Las fechas y el estado los calcula código.",
      "screens.library.reveal": "Mostrar en Archivos",
      "web.zoom.description":
        "El tamaño con que se muestra la app en este ordenador. Ctrl+Plus y Ctrl+Minus cambian el mismo ajuste, así que se conserva al reiniciar; {min, number}–{max, number} %.",
      "web.transcriptMode.optionTitle": "{mode} (Ctrl+O alterna)",
      "web.backups.restore": "Para restaurar en un ordenador nuevo con el Gateway detenido:",
      "web.passkeys.firstApproval":
        "Aprueba «Añadir una llave de acceso» con tu contraseña en tu ordenador o con una llave de acceso en otro dispositivo, y luego vuelve a pulsar Añadir.",
      "web.passkeys.added":
        "Se añadió {name}. Ahora aprueba los cambios que necesitan tu contraseña o una llave de acceso.",
      "web.remotePresence.title": "Tu contraseña para las aprobaciones",
      "web.remotePresence.description":
        "Las compras, el relleno de credenciales, los comandos del host y los cambios de seguridad necesitan tu contraseña o una llave de acceso. Configúralo en este ordenador para responderlos aquí; hasta entonces esas tarjetas indican que hay que responder en {host}. Las aprobaciones normales nunca lo necesitan.",
      "web.remotePresence.on":
        "Las aprobaciones con contraseña están activadas para este ordenador.",
      "web.remotePresence.off":
        "Las aprobaciones con contraseña no están configuradas en este ordenador.",
      "web.remotePresence.enable": "Usar tu contraseña para las aprobaciones en este ordenador",
      "web.remotePresence.waiting": "Esperando tu contraseña…",
      "web.remotePresence.passkeyName": "Tu contraseña en este ordenador",
      "web.remotePresence.enabled":
        "Las aprobaciones con contraseña están activadas para este ordenador.",
      "web.remotePresence.disabled":
        "Las aprobaciones con contraseña están desactivadas en este ordenador.",
      "web.remotePresence.approveOnHost":
        "Aprueba «Añadir una llave de acceso» en {host}, con su Touch ID, Windows Hello o contraseña, o con una llave de acceso, y vuelve a pulsar el botón.",
      "web.remotePresence.unavailable":
        "Las aprobaciones con contraseña necesitan el Gateway de {host} en una dirección https:// (gateway.publicOrigin). Hasta entonces, responde esas tarjetas en {host}.",
      "web.webauthn.noPasskeyYet":
        "Este navegador aún no tiene ninguna llave de acceso. Añade una en Ajustes → Dispositivos, o aprueba en el ordenador que ejecuta el Gateway.",
      "web.webauthn.needsOrigin":
        "Las llaves de acceso necesitan la dirección https del servidor (gateway.publicOrigin). Aprueba en el ordenador que ejecuta el Gateway.",
      "web.setup.gatewayOk": "En ejecución en este ordenador.",
      "web.setup.adminOk": "Este ordenador es el dispositivo administrador.",
      "web.viewers.noSandbox":
        "Las previsualizaciones de diapositivas necesitan el entorno aislado, y no hay ningún entorno de contenedores disponible (Docker o Podman).",
      "web.voice.noEngine":
        "No hay ningún motor de voz disponible. Instala un modelo de voz en Ajustes → Voz, o conecta el asistente de Linux.",
      "web.threads.newSideChatTitle": "Nueva conversación paralela (Ctrl+N)",
      "web.panes.closePaneTitle": "Cerrar el panel (Ctrl+\\)",
      "web.chat.permissionModeTitle": "Modo de permisos (Ctrl+Shift+M)",
      "web.chat.modelTitle": "Modelo (Ctrl+Shift+I)",
      "web.splash.installing": "Configurando Psyche en este ordenador…",
      "web.splash.helper": "Preparando Psyche en tu ordenador…",
      "web.splash.remote.useThisMac": "Usar este ordenador",
      "web.remote.thisMac": "Este ordenador",
      "web.teach.bar.body":
        "Psyche anota tus clics y lo que escribes solo en esta pestaña. Las contraseñas, los números de tarjeta y los códigos nunca se graban, y nada sale de este ordenador hasta que guardes.",
      "settings.teach.storage.description":
        "Cuando pides a Psyche que conserve una grabación para poder hacer otra versión, los pasos se guardan en este ordenador.",
      "settings.teach.storage.encrypted":
        "Cifrada. El archivo se bloquea con una clave guardada en el llavero del sistema, así que no se puede leer fuera de Psyche. Caduca a los 90 días.",
      "settings.teach.storage.unavailable":
        "Las grabaciones no se conservan. El llavero del sistema no está disponible y Psyche no guardará una grabación como texto sin cifrar. Aún puedes guardar una grabación como habilidad.",
      "web.teach.review.keepUnavailable":
        "No disponible: el llavero del sistema no está disponible para cifrar una grabación conservada.",
      "web.teach.review.keepRecording":
        "Conservar esta grabación en este ordenador para poder hacer otra versión",
      "web.teach.app.recordHint": "Mostrar a Psyche cómo hacer algo en una app que ya permitiste",
      "web.teach.app.bar.body":
        "Psyche anota tus clics, tus opciones de menú y lo que escribes solo en {app}. Los campos seguros nunca se graban, no se hacen capturas de pantalla y nada sale de este ordenador hasta que guardes. La bandeja del sistema también tiene un botón Detener.",
      "voice.key.rightOption": "Alt derecha",
      "voice.key.rightCommand": "Ctrl derecha",
      "voice.settings.reviewHint":
        "Deja lo que Psyche oyó en la ventana emergente para que lo corrijas y pulses Enter. Si está desactivado, se envía al soltar la tecla.",
      "meetingRecord.unavailable":
        "Grabar necesita una forma de convertir el audio en notas (un modelo de voz o el asistente de Linux), y no hay ninguna conectada.",
      "meetingRecord.micDenied":
        "Psyche no puede usar el micrófono. Permítelo en la Configuración de tu sistema.",
      "platform.term.os": "Linux",
      "platform.term.device": "ordenador",
      "platform.term.thisDevice": "Este ordenador",
      "platform.term.thisDeviceLower": "este ordenador",
      "platform.term.presence": "tu contraseña",
      "platform.term.secretStore": "Llavero del sistema",
      "platform.term.systemSettings": "Configuración",
      "platform.term.fileManager": "Archivos",
      "platform.term.trayArea": "bandeja del sistema",
      "platform.term.taskbar": "barra de tareas",
      "platform.term.systemSearch": "búsqueda del escritorio",
      "platform.term.helper": "asistente de Linux",
      "platform.term.terminal": "Terminal",
      "platform.term.alt": "Alt",
      "platform.term.mod": "Ctrl",
      "web.security.banner.recovery":
        "{count, plural, one {Un cambio de seguridad pedido en este ordenador se aplica el {when} salvo que lo canceles.} other {# cambios de seguridad pedidos en este ordenador están en espera. El siguiente se aplica el {when}.}}",
      "web.security.alert.changed":
        "Un programa de este ordenador cambió {count, plural, one {1 registro de seguridad} other {# registros de seguridad}} sin pasar por Psyche. Psyche {count, plural, one {lo restauró} other {los restauró}}. Si no fuiste tú, revisa el ordenador en busca de software no deseado.",
      "web.security.alert.untrusted":
        "La comprobación de los registros de seguridad de Psyche falló. Los dispositivos nuevos, los ajustes de seguridad y las aprobaciones con contraseña están bloqueados. Revisa tus dispositivos y luego ejecuta psyched security reseal en el ordenador; se aplica a las 24 horas.",
      "web.security.alert.firstAdmin":
        "Un comando en este ordenador convirtió {name} en el primer dispositivo administrador. Si no fuiste tú, revócalo en Dispositivos.",
      "web.security.alert.requested": "Pedido en este ordenador: {action} Se aplica el {when}.",
      "web.security.op.presenceReset":
        "dejar de pedir tu contraseña o una llave de acceso para los cambios de seguridad hasta que se registre una clave nueva.",
      "web.security.needsApproval":
        "Aprueba la tarjeta con tu contraseña o una llave de acceso y vuelve a pulsar el botón.",
    },
    fr: {
      "settings.devices.nodeKind.hostHelper": "Assistant Linux",
      "settings.links.description":
        "Où s’ouvre un lien d’un message, d’une carte ou d’un artefact. Ctrl+clic utilise toujours votre navigateur par défaut.",
      "errors.presence_required":
        "Confirmez d’abord que c’est bien vous avec votre mot de passe ou une clé d’accès.",
      "chat.toolbar.keySheet": "Ctrl+Shift+A",
      "chat.toolbar.keyModel": "Ctrl+Shift+I",
      "chat.toolbar.keyView": "Ctrl+O",
      "chat.approval.keysHint": "Ctrl+Enter {allows} · Ctrl+D {denies}",
      "blocks.details.runsOnHost": "sur votre ordinateur, hors du bac à sable",
      "blocks.details.runsSandboxed":
        "sur votre ordinateur, dans le bac à sable : il ne peut lire ni le coffre de Psyche, ni vos clés SSH, ni le trousseau de clés système, ni les profils de navigateur",
      "blocks.details.runsNoSandbox":
        "sur votre ordinateur, et le bac à sable n’est pas configuré ({reason})",
      "blocks.permission.need.capability": "Activer « Exécuter des commandes sur cet ordinateur »",
      "blocks.permission.need.macos_access": "Donner l’accès à {connector} dans les Paramètres",
      "blocks.permission.openSystemSettings": "Ouvrir les Paramètres",
      "blocks.approval.answerOnHost":
        "Répondez sur {host}, ou configurez les approbations par mot de passe pour cet ordinateur dans Réglages → Appareils.",
      "blocks.approval.needsAuth":
        "Votre mot de passe ou une clé d’accès est nécessaire pour approuver.",
      "blocks.approval.touchIdFailed":
        "La vérification du mot de passe a échoué : {reason}. Réessayez.",
      "blocks.approval.touchIdFailedNoReason":
        "La vérification du mot de passe a échoué. Réessayez.",
      "blocks.approval.touchId.helperOffline":
        "L’assistant Linux n’est pas en cours d’exécution, votre mot de passe ne peut donc pas confirmer ici.",
      "blocks.approval.touchId.noKey":
        "Les approbations par mot de passe ne sont pas encore configurées sur cet ordinateur. Configurez-les dans Réglages → Appareils, où vous pouvez d’abord vérifier la clé.",
      "blocks.approval.touchId.invalidated":
        "La configuration de votre mot de passe a changé depuis la création de la clé de cet ordinateur, il ne peut donc pas confirmer les approbations. Configurez-la à nouveau dans Réglages → Appareils.",
      "blocks.approval.touchId.noUnsandboxed":
        "L’exécution d’une commande sans bac à sable ne peut pas être approuvée avec votre mot de passe depuis cette fenêtre. Configurez plutôt le bac à sable",
      "blocks.approval.touchId.onceOnly":
        "Les approbations par mot de passe depuis cette fenêtre ne valent qu’une fois.",
      "blocks.approval.status.allowedOnceTouchId":
        "Autorisé une fois (les approbations par mot de passe depuis cette fenêtre ne valent qu’une fois)",
      "blocks.approval.touchId.keyUnavailable":
        "Cette version de l’assistant Linux ne peut pas conserver de clé d’approbation, les cartes qui exigent votre mot de passe ne peuvent donc pas être approuvées sur cet ordinateur.",
      "blocks.approval.touchId.cancelled":
        "La demande de mot de passe a été annulée, rien n’a donc été approuvé",
      "shell.shortcut.pushToTalkKeys": "Maintenir Ctrl droite",
      "settings.shared.needsPresence":
        "Modifier « {label} » nécessite votre approbation avec votre mot de passe ou une clé d’accès. Approuvez-la dans Réglages ou dans la notification de Psyche, puis modifiez-le de nouveau.",
      "settings.page.permissions.description":
        "Ce que {persona} peut faire sur cet ordinateur sans demander, et les cas où il vous demande toujours.",
      "settings.page.data.description":
        "Ce qui reste sur cet ordinateur, combien de temps c’est conservé, les exports, les sauvegardes et la réinitialisation.",
      "settings.essentials.model.noneHint":
        "{persona} a besoin d’un modèle avant de pouvoir répondre. Ajoutez une clé ou utilisez un modèle sur cet ordinateur.",
      "settings.essentials.read.hint":
        "Désactivé tant que vous n’en activez pas un. Ce qui est lu est indexé sur cet ordinateur pour retrouver des éléments pour vous, et la mémoire en tire aussi des enseignements, sauf si vous refusez dans Mémoire → Sources.",
      "settings.searchModel.apple.notOnThisMac": "Disponible sur macOS",
      "settings.macHelper.paired.text":
        "Assure l’utilisation de l’ordinateur, le contexte d’écran, la dictée, les approbations par mot de passe et les notifications sur cet ordinateur.",
      "settings.macHelper.unbundled.text": "Cette version de Psyche n’a pas d’assistant Linux.",
      "settings.key.appearance.showInDock":
        "Afficher dans la barre des tâches quand aucune fenêtre n’est ouverte",
      "settings.semanticSearch.encrypt.pending":
        "En attente de l’ouverture de l’index chiffré par l’assistant Linux",
      "settings.semanticSearch.rerankHint":
        "Un petit modèle cloud place les meilleurs résultats en premier. Les 20 premiers extraits quittent cet ordinateur. Désactivé par défaut.",
      "settings.key.vm.enabled": "Utiliser un ordinateur bac à sable pour les tâches",
      "settings.key.vm.resetPerTask": "Un ordinateur neuf pour chaque tâche",
      "settings.credentials.backend.psyche": "Coffre Psyche (votre mot de passe)",
      "settings.credentials.backend.keychain": "Trousseau de clés système",
      "settings.credentials.backendIn.keychain": "dans le trousseau de clés système",
      "settings.credentials.err.lockedChange":
        "Le coffre est verrouillé. Déverrouillez-le avec votre mot de passe, puis {verb, select, delete {supprimez} other {modifiez}} {name} de nouveau.",
      "settings.credentials.err.lockedImport":
        "Le coffre est verrouillé. Déverrouillez-le avec votre mot de passe, puis importez de nouveau.",
      "settings.credentials.slot.keychain": "le trousseau de clés système (votre mot de passe)",
      "settings.credentials.slot.safeStorage": "le stockage d’app de cet ordinateur",
      "settings.credentials.slot.keyFile": "un fichier de clé sur cet ordinateur",
      "settings.credentials.moveToKeychain": "Déplacer vers le trousseau de clés système",
      "settings.credentials.keyFileExplainer":
        "La clé qui ouvre votre coffre est un fichier que seul votre compte peut lire. La déplacer vers le trousseau de clés système nécessite l’assistant Linux ; l’assistant de cette version n’est pas disponible.",
      "settings.credentials.link.err.locked":
        "Le coffre est verrouillé. Déverrouillez-le avec votre mot de passe, puis liez {name} de nouveau.",
      "settings.approval.presenceUnavailable":
        "Cette fenêtre ne peut pas confirmer que c’est vous. Approuvez la modification dans l’app Psyche sur votre ordinateur (votre mot de passe) ou depuis un appareil avec une clé d’accès. Rien ne change d’ici là.",
      "settings.approval.promptDetail":
        "Les réglages de sécurité nécessitent votre mot de passe ou une clé d’accès. Approuvez ici ou dans la notification de Psyche ; le réglage est enregistré dès l’approbation.",
      "settings.approval.presenceInvalid":
        "Votre mot de passe ou la clé d’accès n’a pas confirmé que c’est bien vous. Réessayez.",
      "settings.about.revealHome": "Afficher dans Fichiers",
      "settings.uninstall.keychainStays":
        "Les éléments du trousseau de clés système restent (la clé du coffre et ceux de l’assistant). Supprimez-les dans votre application de trousseau si vous le souhaitez.",
      "settings.uninstall.keychainGoes":
        "Les éléments du trousseau de clés système pour le coffre et l’assistant sont aussi supprimés.",
      "settings.uninstall.removeKeychain":
        "Supprimer aussi mes éléments du trousseau de clés système (ceux de Psyche). Sans vos données, ils sont inutiles.",
      "settings.uninstall.presence":
        "Il vous sera ensuite demandé de confirmer avec votre mot de passe ou sur cet appareil, car cela supprime vos données.",
      "settings.appearance.showInDockHint":
        "Désactivé, Psyche reste actif dans la zone de notification quand sa dernière fenêtre se ferme.",
      "settings.appearance.openAtLoginHint":
        "Lance Psyche dans la zone de notification à l’ouverture de session, afin que les automatisations planifiées puissent toujours s’exécuter.",
      "settings.browser.letTasksUseHint":
        "Chaque tâche vous demande d’abord, sur cet appareil, avec votre mot de passe ou une clé d’accès.",
      "settings.browser.detailsText":
        "Pendant qu’une tâche l’utilise, Psyche lance Google Chrome avec ce profil et un port DevTools sur l’adresse de bouclage de cet ordinateur (127.0.0.1), puis le ferme à la fin de la tâche. {persona} n’y est pas attaché tant que vous avez vous-même le profil ouvert.",
      "settings.browser.openFromMac":
        "Ouvrez-le depuis l’app Psyche sur l’ordinateur qui exécute la Gateway.",
      "settings.channels.empty":
        "Aucun canal pour l’instant. Connectez Telegram ou Slack pour joindre {persona} loin de cet ordinateur.",
      "settings.computerUse.description":
        "{persona} ne peut utiliser les apps de cet ordinateur que là où vous l’autorisez.",
      "settings.computerUse.macPermissions": "Autorisations du bureau",
      "settings.computerUse.openSystemSettingsFor": "Ouvrir les Paramètres pour {name}",
      "settings.computerUse.openSystemSettings": "Ouvrir les Paramètres",
      "settings.trusted.loading": "Lecture depuis cet ordinateur…",
      "settings.trusted.noHelper":
        "Ouvrez Psyche sur votre ordinateur pour les lister : l’assistant les lit.",
      "settings.trusted.failed": "Psyche n’a pas pu les lire depuis cet ordinateur.",
      "settings.mcp.sandboxHelp":
        "Les serveurs de commandes nécessitent un bac à sable sur cet ordinateur.",
      "settings.sandbox.why":
        "Les commandes s’exécutent sur votre ordinateur avec vos fichiers, mais ne peuvent lire ni votre coffre, ni vos clés, ni les données privées de Psyche.",
      "settings.sandbox.whyHow":
        "Utilise srt, l’environnement d’exécution sandbox d’Anthropic, avec le bac à sable propre à Linux (bubblewrap). Aucune machine virtuelle requise.",
      "settings.sandbox.checking": "Examen de cet ordinateur…",
      "settings.sandbox.containers.body":
        "Un environnement d’exécution de conteneurs exécute le code dans sa propre machine Linux sans accès aux fichiers de votre ordinateur : pour le code exécuté par l’agent et certaines conversions de fichiers. Les serveurs de commandes continuent d’utiliser srt, sauf si la Gateway est configurée pour utiliser des conteneurs.",
      "settings.searchSources.description":
        "Ce que Psyche lit dans votre index de recherche. Tout est désactivé tant que vous ne l’activez pas ; l’index reste sur cet ordinateur. Activer une source permet aussi à la mémoire d’en tirer des enseignements, sauf si vous refusez dans Mémoire → Sources (Mémoire et Contacts font exception : aucun n’est utilisé pour apprendre).",
      "settings.searchSources.runOnBatteryHint":
        "Permet à l’indexation, à la reconstruction et à la lecture du texte dans les images de se poursuivre sur batterie, à un rythme plus doux. Cela consomme plus de batterie. Le mode économie d’énergie suspend toujours l’indexation.",
      "settings.searchSources.ocrHint":
        "Lit les captures d’écran et les PDF numérisés, page par page, sur secteur (ou sur batterie si Indexer sur batterie est activé). Rien ne quitte votre ordinateur.",
      "settings.semanticSearch.description":
        "Retrouvez des éléments par leur sens autant que par leurs mots, le tout sur cet ordinateur.",
      "settings.semanticSearch.engine.builtinHint":
        "Multilingual E5 small, environ 100 langues, s’exécute sur le processeur de cet ordinateur.",
      "settings.semanticSearch.engine.routerHint":
        "Utilise le modèle d’embedding défini dans Rôles, par exemple Ollama ou LM Studio sur cet ordinateur.",
      "settings.semanticSearch.allowCloudHint":
        "Uniquement si le modèle d’embedding est un service cloud. Vos discussions, tâches et le texte de la Bibliothèque lui sont envoyés. Désactivé, tout reste sur cet ordinateur.",
      "settings.semanticSearch.state.cloudBlocked":
        "Le modèle d’embedding défini dans Rôles est un service cloud. La recherche sémantique n’utilise que des modèles présents sur cet ordinateur.",
      "settings.data.encryptMemory.pending": "En attente de la clé de l’assistant Linux.",
      "settings.devices.touchId.none":
        "Pas encore de clé de mot de passe. Les cartes qui exigent votre mot de passe ne peuvent pas être approuvées tant qu’aucune n’est enregistrée.",
      "settings.devices.touchId.noBundledKey":
        "L’assistant Linux de cette app n’a pas de clé d’approbation ({reason}).",
      "settings.devices.touchId.manualHint":
        "Exécutez psyche-helper --print-identity sur l’ordinateur et collez la presenceKeyId affichée.",
      "settings.devices.noNodes":
        "Aucun nœud. L’assistant Linux apparaît ici dès que Psyche s’exécute sur cet ordinateur.",
      "settings.files.execHost": "Exécuter des commandes sur cet ordinateur",
      "settings.files.execHostSwitch": "Autoriser les commandes sur cet ordinateur",
      "settings.model.ram.tooSmall":
        "Cet ordinateur a {gb, number} Go. Les modèles locaux ont besoin d’au moins {min, number} Go ; utilisez plutôt un fournisseur cloud.",
      "settings.model.ram.fits": "Cet ordinateur a {gb, number} Go, donc {fits} conviennent.",
      "settings.model.ram.thisMac": " (cet ordinateur)",
      "settings.model.localHint":
        "Exécutez des modèles sur cet ordinateur avec Ollama ou LM Studio.",
      "settings.permissions.never.browserPasswords":
        "Lire les mots de passe enregistrés dans vos navigateurs ou dans le trousseau de clés système",
      "settings.server.bindHint":
        "127.0.0.1 la garde sur cet ordinateur. Utilisez l’accès à distance ci-dessous plutôt que d’écouter sur toutes les interfaces.",
      "settings.gateways.description":
        "Utilisez Psyche depuis cet ordinateur avec la Gateway d’un autre, par exemple votre ordinateur à la maison. Une seule Gateway est active à la fois, et en changer redémarre Psyche.",
      "settings.gateways.thisMac": "Cet ordinateur",
      "settings.gateways.switchKeep":
        "Psyche redémarre sur {name}. Psyche continue de fonctionner sur cet ordinateur, ses automatisations se poursuivent donc.",
      "settings.gateways.switchAndStop": "Changer et arrêter Psyche sur cet ordinateur",
      "settings.gateways.addHint":
        "Collez le lien de jumelage de l’ordinateur qui exécute Psyche (Réglages, Serveur et accès à distance, Jumeler un autre ordinateur). Sans lien, saisissez son adresse Tailscale, https://<host>.<tailnet>.ts.net ; cet ordinateur demande alors le jumelage, et le propriétaire l’approuve là-bas.",
      "settings.gateways.problem.link_malformed":
        "Ce lien de jumelage est endommagé. Copiez-le à nouveau depuis l’ordinateur qui l’a créé.",
      "settings.gateways.problem.link_bad_field":
        "Ce lien de jumelage est endommagé. Copiez-le à nouveau depuis l’ordinateur qui l’a créé.",
      "settings.gateways.problem.link_lan":
        "Ce lien de jumelage concerne un ordinateur de votre réseau local mais ne contient pas son certificat, il n’est donc pas utilisé. Sur cet ordinateur, créez-en un nouveau : Jumeler un autre ordinateur, Depuis ce réseau.",
      "settings.remote.description":
        "Permettez à Psyche sur un autre ordinateur d’utiliser la Gateway de cet ordinateur via Tailscale. La Gateway reste sur cet ordinateur et n’écoute que Tailscale, et Tailscale Serve est la seule voie d’accès.",
      "settings.remote.step1":
        "Installez Tailscale sur cet ordinateur et sur l’autre ordinateur, et connectez les deux au même tailnet.",
      "settings.remote.step2":
        "Dans un terminal sur cet ordinateur, publiez la Gateway sur votre tailnet. Il s’agit de Serve, pas de Funnel.",
      "settings.remote.step4":
        "Redémarrez Psyche. Puis, sur l’autre ordinateur, ajoutez cet ordinateur comme Gateway. Il affiche un code de jumelage et une empreinte de clé : comparez-les avec la demande sous En attente de jumelage ici, puis approuvez-la.",
      "settings.remote.admin":
        "Un ordinateur jumelé obtient la lecture, l’écriture et les approbations. Admin reste désactivé sauf si vous le cochez lors de l’approbation, et chaque modification d’admin exige toujours votre mot de passe ici.",
      "settings.pair.needsAddress":
        "Définissez d’abord l’adresse publique de cet ordinateur (étape 3 ci-dessus), puis créez un lien de jumelage.",
      "settings.pair.adminHint":
        "Admin lui permet de modifier les réglages de sécurité, les appareils et le coffre, et reste désactivé sauf si vous le cochez. Chaque modification d’admin exige toujours votre mot de passe ici.",
      "settings.pair.compare":
        "Il vérifie la clé de cet ordinateur avant d’utiliser le lien : {fingerprint}. Vous pouvez comparer.",
      "settings.pair.secret":
        "Quiconque possède ce lien dans les dix prochaines minutes peut jumeler un ordinateur. Ne le publiez pas et ne l’envoyez à personne à qui vous ne confieriez pas cet ordinateur.",
      "settings.pair.err.noAddress":
        "Cet ordinateur n’a pas encore d’adresse publique, il n’y a donc rien à mettre dans un lien.",
      "settings.pair.viaAddress": "Via Tailscale, à l’adresse de cet ordinateur",
      "settings.pair.viaLanHint":
        "Un lien pour ce réseau contient la clé et le certificat de cet ordinateur, et ne fonctionne donc que pour les ordinateurs sur le même Wi-Fi ou Ethernet.",
      "settings.pair.lanNote":
        "Ce lien est destiné aux ordinateurs du même réseau que cet ordinateur. Il nomme la clé et le certificat que Psyche exigera.",
      "settings.lan.description":
        "Permettez à Psyche sur un autre ordinateur du même Wi-Fi ou Ethernet d’accéder à la Gateway de cet ordinateur, sans Tailscale. C’est désactivé tant que vous ne l’activez pas.",
      "settings.lan.toggleHint":
        "Psyche écoute sur un réseau, via une connexion chiffrée avec son propre certificat. Un ordinateur qui se connecte doit tout de même être approuvé ici avec votre mot de passe.",
      "settings.lan.noInterface":
        "Aucune connexion Wi-Fi ou Ethernet n’a été trouvée sur cet ordinateur.",
      "settings.lan.notAdvertised": "Non visible. Ajoutez cet ordinateur par son adresse.",
      "settings.lan.problem.unknownInterface": "{name} n’est pas un réseau de cet ordinateur.",
      "settings.lan.problem.advertise":
        "Psyche n’a pas pu s’annoncer sur le réseau. Les ordinateurs peuvent toujours ajouter cet ordinateur par son adresse.",
      "settings.server.noVm":
        "Aucune VM. Le mode VM exécute Psyche dans un ordinateur invité séparé ; configurez-le depuis la configuration initiale.",
      "settings.shortcut.key.Control": "Ctrl",
      "settings.shortcut.key.Alt": "Alt",
      "settings.skills.permission.exec_host": "Exécuter des commandes sur cet ordinateur",
      "settings.skills.permission.computer_action": "Utiliser des apps sur cet ordinateur",
      "settings.skills.pathPlaceholder": "/home/vous/Downloads/pdf-merge",
      "settings.skills.signer.originAgent":
        "Rédigé par un assistant sur l’ordinateur de l’expéditeur. Lisez-le comme un texte non vérifié, quel que soit le signataire.",
      "settings.skills.export.hint":
        "Le fichier est signé avec votre clé d’auteur, afin que ceux qui le reçoivent puissent voir qu’il vient de vous et qu’il n’a pas été modifié. La clé reste sur cet ordinateur.",
      "settings.vm.phase.installing": "Configuration de l’invité",
      "settings.vm.description":
        "Exécutez les tâches dans un ordinateur bac à sable séparé, pour que {persona} travaille dans sa propre copie de Linux plutôt que dans la vôtre.",
      "settings.vm.sandboxMac": "Ordinateur bac à sable",
      "settings.vm.between": "Entre votre ordinateur et l’invité",
      "settings.vm.credentialsHint":
        "Avec le coffre de l’hôte, les valeurs restent sur votre ordinateur. Un coffre invité conserve sa propre copie.",
      "settings.vm.noReports":
        "Aucun invité ne s’est encore signalé. Créez-en un depuis l’assistant Psyche sur cet ordinateur ; son état s’affichera ici.",
      "settings.voice.key.rightOption": "Alt droite",
      "settings.voice.key.rightCommand": "Ctrl droite",
      "settings.voice.reply.gatewayHint": "La voix définie pour le persona, ou la voix système.",
      "settings.voice.engine.local": "Sur cet ordinateur",
      "settings.voice.engine.localHint":
        "Whisper s’exécute localement ; l’audio ne quitte jamais l’ordinateur.",
      "settings.voice.engine.system": "Dictée du système",
      "settings.voice.engine.systemHint":
        "La reconnaissance vocale du système, sur l’appareil, via l’assistant Linux.",
      "settings.voice.model.usingHelper":
        "La dictée utilise la reconnaissance vocale de l’assistant. Le modèle vocal transcrit mieux et s’exécute sur cet ordinateur.",
      "settings.voice.model.downloadHint":
        "Un téléchargement unique depuis le projet whisper.cpp, vérifié avant son utilisation. L’audio ne quitte jamais cet ordinateur.",
      "settings.voice.model.ready": "Whisper ({model}) sur cet ordinateur",
      "settings.voice.model.readyHint":
        "La dictée et les enregistrements sont transcrits ici ; l’audio ne quitte jamais l’ordinateur.",
      "settings.connect.finishOpened":
        "La connexion à {name} s’est ouverte dans votre navigateur, sur l’ordinateur de la Gateway. Cet écran se mettra à jour quand ce sera fait.",
      "settings.connect.needsPermission":
        "{name} est configuré, mais le système ne l’a pas encore autorisé. Autorisez-le dans",
      "settings.connect.openSystemSettings": "Ouvrir les Paramètres",
      "settings.people.description":
        "Les fiches que {persona} tient pour les personnes et les projets de votre vie. Elles restent sur cet ordinateur, et chaque fait indique sa provenance.",
      "settings.about.versionsHint": "Ce qui s’exécute sur cet ordinateur.",
      "settings.computerUse.macPermissionsHint": "Ce que le bureau autorise.",
      "settings.connectorBundle.sandbox.none":
        "Cet ordinateur n’a pas de bac à sable pour les connecteurs de commande, et Psyche n’en exécute jamais en dehors. Ce connecteur ne peut pas être installé ici. Rien n’a été démarré ni enregistré.",
      "settings.connectorBundle.share.unavailable":
        "Seul Psyche sur l’ordinateur qui l’exécute peut signer un connecteur.",
      "settings.deviceAccess.files.title": "Fichiers sur cet ordinateur",
      "settings.deviceAccess.terminal.hint":
        "{persona} peut exécuter des commandes de terminal sur cet ordinateur lorsque Exécuter des commandes sur cet ordinateur est activé dans Autorisations → Accès.",
      "settings.deviceAccess.terminal.where":
        "Les commandes s’exécutent sur votre ordinateur, dans les dossiers que vous avez partagés, et ne peuvent écrire que dans un dossier partagé en lecture et écriture.",
      "settings.mcp.needs.title": "Ce dont cela a besoin sur votre ordinateur",
      "settings.mcp.needs.node.fix":
        "S’exécute sur le propre Node de Psyche ; nécessite npm sur cet ordinateur. Installez Node.js depuis nodejs.org, ou avec votre gestionnaire de paquets.",
      "settings.mcp.needs.uv.fix": "Un serveur Python. Installez uv depuis docs.astral.sh/uv.",
      "settings.mcp.fail.node_missing":
        "Installez Node.js (nodejs.org, ou votre gestionnaire de paquets) pour que npm soit présent sur cet ordinateur, puis vérifiez à nouveau.",
      "settings.mcp.fail.uv_missing":
        "Installez uv (docs.astral.sh/uv), puis vérifiez à nouveau le serveur.",
      "settings.mail.voice.learn.hint":
        "Wren ne lit que ce que vous avez écrit dans vos mails envoyés, sans le texte cité ni les signatures. Le profil reste sur cet ordinateur dans mail/VOICE.md.",
      "settings.mail.voice.localModel.hint":
        "Les brouillons dans votre style ne quittent jamais cet ordinateur.",
      "settings.mail.transcribe.endpoint.hint":
        "Facultatif. Un serveur compatible OpenAI pour /v1/audio/transcriptions (par exemple whisper.cpp sur cet ordinateur). Utilisé lorsque l’assistant Linux n’a pas de moteur de reconnaissance vocale. L’audio n’est envoyé qu’à cette adresse : https, ou http sur 127.0.0.1.",
      "onboarding.mail.voiceHint":
        "Ne lit que ce que vous avez écrit, sans le texte cité ni les signatures. Cela reste sur cet ordinateur et vous pouvez l’afficher, le modifier ou le réinitialiser.",
      "gallery.preset.git.field.repo.help":
        "Le dossier d’un dépôt Git sur cet ordinateur. Psyche peut en lire l’historique et les différences.",
      "settings.connectors.page.onThisMac": "Sur cet ordinateur",
      "settings.connectors.page.row.local": "S’exécute sur cet ordinateur",
      "settings.connectors.page.server.local":
        "Un outil qui s’exécute dans un bac à sable sur cet ordinateur",
      "onboarding.permission.denied": "Désactivée dans les Paramètres",
      "onboarding.permission.deniedHint":
        "Activez-la dans les Paramètres de votre système ; cette page se mettra à jour à votre retour.",
      "onboarding.permission.unavailableHint":
        "Psyche ne peut la demander que depuis l’app de bureau Psyche.",
      "onboarding.connectors.onThisMac": "Sur cet ordinateur",
      "onboarding.connectors.onThisMacHint":
        "Chaque app demande l’autorisation au système lors de sa connexion, une par une.",
      "onboarding.model.kind.localHint": "S’exécute sur cet ordinateur ; rien n’en sort.",
      "onboarding.model.subscriptionNote":
        "Psyche utilise l’app Claude Code ou Codex déjà connectée sur cet ordinateur ; il n’a donc besoin d’aucune clé API et n’en enregistre aucune. Connectez-vous d’abord là-bas si ce n’est pas fait.",
      "onboarding.safety.touchId": "Votre mot de passe pour les approbations",
      "onboarding.safety.touchId.checking": "Examen de l’assistant Linux…",
      "onboarding.safety.touchId.setHint":
        "Les approbations qui ont besoin de vous demandent votre mot de passe.",
      "onboarding.safety.touchId.starting":
        "L’assistant Linux démarre encore. Vérifiez à nouveau dans un instant.",
      "onboarding.safety.touchId.noKey":
        "L’assistant Linux n’a pas de clé d’approbation ({reason}).",
      "onboarding.safety.touchId.hint":
        "Enregistrez une seule fois la clé de l’assistant Linux pour que votre mot de passe puisse confirmer les approbations.",
      "onboarding.safety.asks":
        "Si vous autorisez {name} à exécuter des commandes sur cet ordinateur, celles qui ne font que lire, comme ls ou cat, s’exécutent sans carte. Tout le reste vous demande d’abord.",
      "onboarding.done.touchId": "Votre mot de passe",
      "onboarding.done.try.search":
        "Posez une question dans Recherche (Ctrl+K). La réponse indique d’où dans votre vie elle provient.",
      "screens.search.source.revealFile": "Afficher dans Fichiers",
      "everything.model.localHint":
        "Un modèle sur cet ordinateur lit tout. Rien ne quitte l’ordinateur. Moins de faits, plus bruités.",
      "everything.run.reason.battery":
        "Pas maintenant : l’ordinateur est sur batterie. Branchez-le, ou autorisez les exécutions sur batterie.",
      "everything.run.reason.thermal": "Pas maintenant : l’ordinateur est trop chaud.",
      "everything.run.reason.not_idle": "Pas maintenant : vous utilisez l’ordinateur.",
      "everything.storage.note": "Tout est stocké uniquement sur cet ordinateur.",
      "memoryWork.consent.k1":
        "Rien ne quitte cet ordinateur. Les dates et statuts sont déterminés par du code.",
      "screens.library.reveal": "Afficher dans Fichiers",
      "web.zoom.description":
        "La taille d’affichage de l’app sur cet ordinateur. Ctrl+Plus et Ctrl+Minus modifient le même réglage, qui survit donc à un redémarrage ; {min, number}–{max, number} %.",
      "web.transcriptMode.optionTitle": "{mode} (Ctrl+O pour passer au suivant)",
      "web.backups.restore": "Restaurer sur un nouvel ordinateur, la Gateway arrêtée :",
      "web.passkeys.firstApproval":
        "Approuvez « Ajouter une clé d’accès » avec votre mot de passe sur votre ordinateur ou avec une clé d’accès sur un autre appareil, puis appuyez de nouveau sur Ajouter.",
      "web.passkeys.added":
        "{name} ajoutée. Elle approuve désormais les modifications qui nécessitent votre mot de passe ou une clé d’accès.",
      "web.remotePresence.title": "Votre mot de passe pour les approbations",
      "web.remotePresence.description":
        "Les achats, saisies d’identifiants, commandes de l’hôte et modifications de sécurité exigent votre mot de passe ou une clé d’accès. Configurez-le sur cet ordinateur pour y répondre ici ; d’ici là, ces cartes indiquent de répondre sur {host}. Les approbations ordinaires n’en ont jamais besoin.",
      "web.remotePresence.on":
        "Les approbations par mot de passe sont activées pour cet ordinateur.",
      "web.remotePresence.off":
        "Les approbations par mot de passe ne sont pas configurées sur cet ordinateur.",
      "web.remotePresence.enable":
        "Utiliser votre mot de passe pour les approbations sur cet ordinateur",
      "web.remotePresence.waiting": "En attente de votre mot de passe…",
      "web.remotePresence.passkeyName": "Votre mot de passe sur cet ordinateur",
      "web.remotePresence.enabled":
        "Les approbations par mot de passe sont activées pour cet ordinateur.",
      "web.remotePresence.disabled":
        "Les approbations par mot de passe sont désactivées sur cet ordinateur.",
      "web.remotePresence.approveOnHost":
        "Approuvez « Ajouter une clé d’accès » sur {host}, avec son Touch ID, Windows Hello ou son mot de passe, ou une clé d’accès, puis appuyez de nouveau sur le bouton.",
      "web.remotePresence.unavailable":
        "Les approbations par mot de passe nécessitent la Gateway de {host} à une adresse https:// (gateway.publicOrigin). D’ici là, répondez à ces cartes sur {host}.",
      "web.webauthn.noPasskeyYet":
        "Ce navigateur n’a pas encore de clé d’accès. Ajoutez-en une dans Réglages → Appareils et nœuds, ou approuvez sur l’ordinateur qui exécute la Gateway.",
      "web.webauthn.needsOrigin":
        "Les clés d’accès nécessitent l’adresse https du serveur (gateway.publicOrigin). Approuvez plutôt sur l’ordinateur qui exécute la Gateway.",
      "web.setup.gatewayOk": "En cours d’exécution sur cet ordinateur.",
      "web.setup.adminOk": "Cet ordinateur est l’appareil administrateur.",
      "web.viewers.noSandbox":
        "L’aperçu des diapositives nécessite le bac à sable, et aucun moteur de conteneurs (Docker ou Podman) n’est disponible.",
      "web.voice.noEngine":
        "Aucun moteur de reconnaissance vocale n’est disponible. Installez un modèle de reconnaissance vocale dans Réglages → Voix, ou connectez l’assistant Linux.",
      "web.threads.newSideChatTitle": "Nouvelle discussion annexe (Ctrl+N)",
      "web.panes.closePaneTitle": "Fermer le panneau (Ctrl+\\)",
      "web.chat.permissionModeTitle": "Mode d’autorisation (Ctrl+Shift+M)",
      "web.chat.modelTitle": "Modèle (Ctrl+Shift+I)",
      "web.splash.installing": "Configuration de Psyche sur cet ordinateur…",
      "web.splash.helper": "Préparation de Psyche sur votre ordinateur…",
      "web.splash.remote.useThisMac": "Utiliser cet ordinateur",
      "web.remote.thisMac": "Cet ordinateur",
      "web.teach.bar.body":
        "Psyche note vos clics et saisies dans cet onglet uniquement. Les mots de passe, numéros de carte et codes ne sont jamais enregistrés, et rien ne quitte cet ordinateur avant que vous n’enregistriez.",
      "settings.teach.storage.description":
        "Quand vous demandez à Psyche de conserver un enregistrement pour pouvoir en créer une autre version, les étapes sont enregistrées sur cet ordinateur.",
      "settings.teach.storage.encrypted":
        "Chiffré. Le fichier est verrouillé par une clé conservée dans le trousseau de clés système et ne peut donc pas être lu en dehors de Psyche. Il expire après 90 jours.",
      "settings.teach.storage.unavailable":
        "Les enregistrements ne sont pas conservés. Le trousseau de clés système n’est pas disponible, et Psyche n’enregistre pas un enregistrement en clair. Vous pouvez toujours enregistrer un enregistrement comme compétence.",
      "web.teach.review.keepUnavailable":
        "Indisponible : le trousseau de clés système n’est pas disponible pour chiffrer un enregistrement conservé.",
      "web.teach.review.keepRecording":
        "Conserver cet enregistrement sur cet ordinateur pour pouvoir en créer une autre version",
      "web.teach.app.recordHint":
        "Montrer à Psyche comment faire quelque chose dans une app que vous avez déjà autorisée",
      "web.teach.app.bar.body":
        "Psyche note vos clics, vos choix de menu et votre saisie dans {app} uniquement. Les champs sécurisés ne sont jamais enregistrés, aucune capture d’écran n’est faite, et rien ne quitte cet ordinateur avant que vous n’enregistriez. La zone de notification propose aussi un bouton Arrêter.",
      "voice.key.rightOption": "Alt droite",
      "voice.key.rightCommand": "Ctrl droite",
      "voice.settings.reviewHint":
        "Garde ce que Psyche a entendu dans la fenêtre flottante pour que vous le corrigiez et appuyiez sur Entrée. Désactivé, l’envoi se fait quand vous relâchez la touche.",
      "meetingRecord.unavailable":
        "L’enregistrement nécessite un moyen de transformer l’audio en notes (un modèle de reconnaissance vocale ou l’assistant Linux), et aucun n’est connecté.",
      "meetingRecord.micDenied":
        "Psyche ne peut pas utiliser le microphone. Autorisez-le dans les Paramètres de votre système.",
      "platform.term.os": "Linux",
      "platform.term.device": "ordinateur",
      "platform.term.thisDevice": "Cet ordinateur",
      "platform.term.thisDeviceLower": "cet ordinateur",
      "platform.term.presence": "votre mot de passe",
      "platform.term.secretStore": "Trousseau de clés système",
      "platform.term.systemSettings": "Paramètres",
      "platform.term.fileManager": "Fichiers",
      "platform.term.trayArea": "zone de notification",
      "platform.term.taskbar": "barre des tâches",
      "platform.term.systemSearch": "recherche du bureau",
      "platform.term.helper": "assistant Linux",
      "platform.term.terminal": "Terminal",
      "platform.term.alt": "Alt",
      "platform.term.mod": "Ctrl",
      "web.security.banner.recovery":
        "{count, plural, one {Une modification de sécurité demandée sur cet ordinateur s’applique le {when}, sauf si vous l’annulez.} other {# modifications de sécurité demandées sur cet ordinateur sont en attente. La prochaine s’applique le {when}.}}",
      "web.security.alert.changed":
        "Un programme de cet ordinateur a modifié {count, plural, one {1 donnée de sécurité} other {# données de sécurité}} sans passer par Psyche. Psyche {count, plural, one {l’a rétablie} other {les a rétablies}}. Si ce n’était pas vous, recherchez un logiciel indésirable sur cet ordinateur.",
      "web.security.alert.untrusted":
        "La vérification des données de sécurité de Psyche a échoué. Les nouveaux appareils, les réglages de sécurité et les approbations par mot de passe sont bloqués. Vérifiez vos appareils, puis exécutez psyched security reseal sur l’ordinateur ; cela s’applique après 24 heures.",
      "web.security.alert.firstAdmin":
        "Une commande sur cet ordinateur a fait de {name} le premier appareil administrateur. Si ce n’était pas vous, révoquez-le dans Appareils.",
      "web.security.alert.requested": "Demandé sur cet ordinateur : {action} S’applique le {when}.",
      "web.security.op.presenceReset":
        "ne plus exiger votre mot de passe ni de clé d’accès pour les modifications de sécurité jusqu’à l’enregistrement d’une nouvelle clé.",
      "web.security.needsApproval":
        "Approuvez la carte avec votre mot de passe ou une clé d’accès, puis appuyez de nouveau sur le bouton.",
    },
    hi: {
      "settings.devices.nodeKind.hostHelper": "Linux हेल्पर",
      "settings.links.description":
        "चैट संदेश, कार्ड या आर्टिफ़ैक्ट का लिंक कहाँ खुले। Ctrl+क्लिक हमेशा डिफ़ॉल्ट ब्राउज़र में खुलता है।",
      "errors.presence_required": "पहले अपने पासवर्ड या पासकी से पुष्टि करें कि यह आप ही हैं।",
      "chat.toolbar.keySheet": "Ctrl+Shift+A",
      "chat.toolbar.keyModel": "Ctrl+Shift+I",
      "chat.toolbar.keyView": "Ctrl+O",
      "chat.approval.keysHint": "Ctrl+Enter {allows} · Ctrl+D {denies}",
      "blocks.details.runsOnHost": "आपके कंप्यूटर पर, सैंडबॉक्स के बाहर",
      "blocks.details.runsSandboxed":
        "आपके कंप्यूटर पर, सैंडबॉक्स में: यह Psyche के वॉल्ट, आपकी SSH कुंजियों, सिस्टम कीरिंग या ब्राउज़र प्रोफ़ाइल को नहीं पढ़ सकता",
      "blocks.details.runsNoSandbox": "आपके कंप्यूटर पर, और सैंडबॉक्स सेट अप नहीं है ({reason})",
      "blocks.permission.need.capability": "“इस कंप्यूटर पर कमांड चलाएँ” चालू करें",
      "blocks.permission.need.macos_access": "सेटिंग्ज़ में {connector} को एक्सेस दें",
      "blocks.permission.openSystemSettings": "सेटिंग्ज़ खोलें",
      "blocks.approval.answerOnHost":
        "{host} पर जवाब दें, या सेटिंग्ज़ → डिवाइस में इस कंप्यूटर पर स्वीकृतियों के लिए पासवर्ड सेट अप करें।",
      "blocks.approval.needsAuth": "स्वीकृत करने के लिए आपका पासवर्ड या पासकी चाहिए।",
      "blocks.approval.touchIdFailed": "पासवर्ड जाँच विफल: {reason}। फिर कोशिश करें।",
      "blocks.approval.touchIdFailedNoReason": "पासवर्ड जाँच विफल। फिर कोशिश करें।",
      "blocks.approval.touchId.helperOffline":
        "Linux हेल्पर नहीं चल रहा, इसलिए आपका पासवर्ड यहाँ से पुष्टि नहीं कर सकता।",
      "blocks.approval.touchId.noKey":
        "इस कंप्यूटर पर स्वीकृतियों के लिए पासवर्ड अभी सेट अप नहीं है। इसे सेटिंग्ज़ → डिवाइस में सेट अप करें, जहाँ आप पहले कुंजी जाँच सकते हैं।",
      "blocks.approval.touchId.invalidated":
        "इस कंप्यूटर की कुंजी सेट अप होने के बाद आपका पासवर्ड सेटअप बदल गया है, इसलिए वह स्वीकृतियों की पुष्टि नहीं कर सकता। इसे सेटिंग्ज़ → डिवाइस में फिर से सेट अप करें।",
      "blocks.approval.touchId.noUnsandboxed":
        "बिना सैंडबॉक्स कमांड चलाने को इस विंडो से आपके पासवर्ड द्वारा स्वीकृत नहीं किया जा सकता। इसके बजाय सैंडबॉक्स सेट अप करें",
      "blocks.approval.touchId.onceOnly": "इस विंडो से पासवर्ड स्वीकृतियाँ सिर्फ़ एक बार के लिए होती हैं।",
      "blocks.approval.status.allowedOnceTouchId":
        "एक बार अनुमति दी गई (इस विंडो से पासवर्ड स्वीकृतियाँ सिर्फ़ एक बार के लिए होती हैं)",
      "blocks.approval.touchId.keyUnavailable":
        "Linux हेल्पर का यह बिल्ड स्वीकृति कुंजी नहीं रख सकता, इसलिए जिन कार्डों को आपका पासवर्ड चाहिए उन्हें इस कंप्यूटर पर स्वीकृत नहीं किया जा सकता।",
      "blocks.approval.touchId.cancelled": "पासवर्ड प्रॉम्प्ट रद्द किया गया, इसलिए कुछ भी स्वीकृत नहीं हुआ",
      "shell.shortcut.pushToTalkKeys": "दायाँ Ctrl दबाए रखें",
      "settings.shared.needsPresence":
        "“{label}” बदलने के लिए आपके पासवर्ड या पासकी से आपकी स्वीकृति चाहिए। इसे सेटिंग्ज़ में या Psyche सूचना में स्वीकृत करें, फिर इसे दोबारा बदलें।",
      "settings.page.permissions.description":
        "इस कंप्यूटर पर {persona} बिना पूछे क्या कर सकता है, और कहाँ वह हमेशा रुककर आपसे पूछता है।",
      "settings.page.data.description":
        "इस कंप्यूटर पर क्या रहता है, कितने समय रखा जाता है, एक्सपोर्ट, बैकअप और नए सिरे से शुरू करना।",
      "settings.essentials.model.noneHint":
        "जवाब देने से पहले {persona} को एक मॉडल चाहिए। कुंजी जोड़ें, या इस कंप्यूटर पर कोई मॉडल उपयोग करें।",
      "settings.essentials.read.hint":
        "जब तक आप कोई चालू नहीं करते, बंद रहता है। जो यह पढ़ता है वह आपके लिए चीज़ें खोजने के लिए इस कंप्यूटर पर इंडेक्स होता है, और मेमोरी भी उससे सीखती है जब तक कि आप मेमोरी → स्रोत में बाहर न रखें।",
      "settings.searchModel.apple.notOnThisMac": "macOS पर उपलब्ध",
      "settings.macHelper.paired.text":
        "इस कंप्यूटर पर कंप्यूटर उपयोग, स्क्रीन संदर्भ, श्रुतलेख, पासवर्ड स्वीकृतियाँ और सूचनाएँ चलाता है।",
      "settings.macHelper.unbundled.text": "Psyche के इस बिल्ड में कोई Linux हेल्पर नहीं है।",
      "settings.key.appearance.showInDock": "कोई विंडो खुली न होने पर टास्कबार में दिखाएँ",
      "settings.semanticSearch.encrypt.pending": "Linux हेल्पर के एन्क्रिप्टेड इंडेक्स खोलने की प्रतीक्षा में",
      "settings.semanticSearch.rerankHint":
        "एक छोटा क्लाउड मॉडल सबसे अच्छे नतीजे सबसे ऊपर रखता है। शीर्ष 20 अंश इस कंप्यूटर से बाहर जाते हैं। डिफ़ॉल्ट रूप से बंद।",
      "settings.key.vm.enabled": "टास्क के लिए सैंडबॉक्स कंप्यूटर का उपयोग करें",
      "settings.key.vm.resetPerTask": "हर टास्क के लिए नया कंप्यूटर",
      "settings.credentials.backend.psyche": "Psyche वॉल्ट (आपका पासवर्ड)",
      "settings.credentials.backend.keychain": "सिस्टम कीरिंग",
      "settings.credentials.backendIn.keychain": "सिस्टम कीरिंग में",
      "settings.credentials.err.lockedChange":
        "वॉल्ट लॉक है। इसे अपने पासवर्ड से अनलॉक करें, फिर {name} को दोबारा {verb, select, delete {डिलीट करें} other {बदलें}}।",
      "settings.credentials.err.lockedImport":
        "वॉल्ट लॉक है। इसे अपने पासवर्ड से अनलॉक करें, फिर दोबारा इंपोर्ट करें।",
      "settings.credentials.slot.keychain": "सिस्टम कीरिंग (आपका पासवर्ड)",
      "settings.credentials.slot.safeStorage": "इस कंप्यूटर का ऐप संग्रहण",
      "settings.credentials.slot.keyFile": "इस कंप्यूटर पर एक कुंजी फ़ाइल",
      "settings.credentials.moveToKeychain": "सिस्टम कीरिंग में ले जाएँ",
      "settings.credentials.keyFileExplainer":
        "आपके वॉल्ट को खोलने वाली कुंजी एक ऐसी फ़ाइल है जिसे केवल आपका खाता पढ़ सकता है। इसे सिस्टम कीरिंग में ले जाने के लिए Linux हेल्पर चाहिए; इस बिल्ड का हेल्पर उपलब्ध नहीं है।",
      "settings.credentials.link.err.locked":
        "वॉल्ट लॉक है। इसे अपने पासवर्ड से अनलॉक करें, फिर {name} को दोबारा लिंक करें।",
      "settings.approval.presenceUnavailable":
        "यह विंडो पुष्टि नहीं कर सकती कि यह आप हैं। बदलाव को अपने कंप्यूटर पर Psyche ऐप में (आपका पासवर्ड), या पासकी वाले किसी डिवाइस से स्वीकृत करें। तब तक कुछ नहीं बदलता।",
      "settings.approval.promptDetail":
        "सुरक्षा सेटिंग्ज़ के लिए आपका पासवर्ड या पासकी चाहिए। इसे यहाँ या Psyche सूचना में स्वीकृत करें; स्वीकृत होते ही सेटिंग सेव हो जाती है।",
      "settings.approval.presenceInvalid":
        "आपके पासवर्ड या पासकी से पुष्टि नहीं हुई कि यह आप ही हैं। फिर से कोशिश करें।",
      "settings.about.revealHome": "फ़ाइलें में दिखाएँ",
      "settings.uninstall.keychainStays":
        "सिस्टम कीरिंग आइटम बने रहते हैं (वॉल्ट की कुंजी और सहायक के आइटम)। चाहें तो उन्हें अपने कीरिंग ऐप में हटा दें।",
      "settings.uninstall.keychainGoes": "वॉल्ट और सहायक के सिस्टम कीरिंग आइटम भी हटा दिए जाते हैं।",
      "settings.uninstall.removeKeychain":
        "मेरे सिस्टम कीरिंग आइटम भी हटाएँ (जो Psyche के हैं)। आपके डेटा के बिना वे बेकार हैं।",
      "settings.uninstall.presence":
        "इसके बाद आपसे अपने पासवर्ड से या इस डिवाइस पर पुष्टि करने को कहा जाएगा, क्योंकि इससे आपका डेटा हट जाता है।",
      "settings.appearance.showInDockHint":
        "बंद होने पर, आखिरी विंडो बंद होने के बाद Psyche सिस्टम ट्रे में चलता रहता है।",
      "settings.appearance.openAtLoginHint":
        "आपके साइन इन करने पर Psyche को सिस्टम ट्रे में शुरू करता है, ताकि शेड्यूल किए ऑटोमेशन हमेशा चल सकें।",
      "settings.browser.letTasksUseHint":
        "हर टास्क फिर भी पहले आपसे पूछता है, इस डिवाइस पर आपके पासवर्ड या पासकी से।",
      "settings.browser.detailsText":
        "जब कोई टास्क इसका उपयोग करता है, तो Psyche इस प्रोफ़ाइल और इस कंप्यूटर के लूपबैक (127.0.0.1) पर DevTools पोर्ट के साथ Google Chrome चलाता है, और टास्क पूरा होने पर इसे बंद कर देता है। जब आप स्वयं प्रोफ़ाइल खोले हुए हों, तब {persona} जुड़ा नहीं होता।",
      "settings.browser.openFromMac": "इसे उस कंप्यूटर पर Psyche ऐप से खोलें जो Gateway चलाता है।",
      "settings.channels.empty":
        "अभी कोई चैनल नहीं। इस कंप्यूटर से दूर रहते हुए {persona} तक पहुँचने के लिए Telegram या Slack कनेक्ट करें।",
      "settings.computerUse.description":
        "{persona} इस कंप्यूटर पर ऐप केवल वहीं उपयोग कर सकता है जहाँ आप अनुमति दें।",
      "settings.computerUse.macPermissions": "डेस्कटॉप अनुमतियाँ",
      "settings.computerUse.openSystemSettingsFor": "{name} के लिए सेटिंग्ज़ खोलें",
      "settings.computerUse.openSystemSettings": "सेटिंग्ज़ खोलें",
      "settings.trusted.loading": "इस कंप्यूटर से पढ़ा जा रहा है…",
      "settings.trusted.noHelper": "उन्हें सूचीबद्ध करने के लिए अपने कंप्यूटर पर Psyche खोलें: हेल्पर उन्हें पढ़ता है।",
      "settings.trusted.failed": "Psyche उन्हें इस कंप्यूटर से पढ़ नहीं सका।",
      "settings.mcp.sandboxHelp": "कमांड सर्वर को इस कंप्यूटर पर सैंडबॉक्स चाहिए।",
      "settings.sandbox.why":
        "कमांड आपके कंप्यूटर पर आपकी फ़ाइलों के साथ चलते हैं, लेकिन आपका वॉल्ट, कुंजियाँ या Psyche का निजी डेटा नहीं पढ़ सकते।",
      "settings.sandbox.whyHow":
        "यह Linux के अपने सैंडबॉक्सिंग (bubblewrap) के साथ Anthropic के सैंडबॉक्स रनटाइम srt का उपयोग करता है। किसी वर्चुअल मशीन की ज़रूरत नहीं।",
      "settings.sandbox.checking": "इस कंप्यूटर को देखा जा रहा है…",
      "settings.sandbox.containers.body":
        "कंटेनर रनटाइम कोड को अपनी अलग Linux मशीन में चलाता है जिसे आपके कंप्यूटर की फ़ाइलों तक पहुँच नहीं होती: एजेंट द्वारा चलाए कोड और कुछ फ़ाइल रूपांतरणों के लिए। कमांड सर्वर srt ही उपयोग करते रहते हैं, जब तक Gateway को कंटेनर इस्तेमाल करने के लिए सेट न किया जाए।",
      "settings.searchSources.description":
        "Psyche आपके खोज इंडेक्स में क्या पढ़ता है। जब तक आप चालू नहीं करते, सब बंद है; इंडेक्स इसी कंप्यूटर पर रहता है। किसी स्रोत को चालू करने से मेमोरी भी उससे सीख सकती है, जब तक आप मेमोरी → स्रोत में बाहर न रखें (मेमोरी और संपर्क अपवाद हैं: दोनों से सीखा नहीं जाता)।",
      "settings.searchSources.runOnBatteryHint":
        "कंप्यूटर के बैटरी पर चलते समय इंडेक्सिंग, रीबिल्ड और चित्रों में टेक्स्ट पढ़ना धीमी गति से जारी रहने देता है। इसमें ज़्यादा बैटरी लगती है। ऊर्जा बचत मोड फिर भी इंडेक्सिंग रोक देता है।",
      "settings.searchSources.ocrHint":
        "स्क्रीनशॉट और स्कैन किए PDF को एक बार में एक पेज पढ़ता है, चार्जर लगे होने पर (या “बैटरी पर इंडेक्स करें” चालू होने पर बैटरी पर)। कुछ आपके कंप्यूटर से बाहर नहीं जाता।",
      "settings.semanticSearch.description": "चीज़ें शब्दों के साथ-साथ अर्थ से भी खोजें, सब कुछ इसी कंप्यूटर पर।",
      "settings.semanticSearch.engine.builtinHint":
        "Multilingual E5 small, लगभग 100 भाषाएँ, इस कंप्यूटर के प्रोसेसर पर चलता है।",
      "settings.semanticSearch.engine.routerHint":
        "भूमिकाओं में सेट एम्बेडिंग मॉडल उपयोग करता है, जैसे इस कंप्यूटर पर Ollama या LM Studio।",
      "settings.semanticSearch.allowCloudHint":
        "सिर्फ़ तब जब एम्बेडिंग मॉडल क्लाउड सेवा हो। आपकी चैट, टास्क और लाइब्रेरी का टेक्स्ट उसे भेजा जाता है। बंद रखने पर सब कुछ इसी कंप्यूटर पर रहता है।",
      "settings.semanticSearch.state.cloudBlocked":
        "भूमिकाओं में एम्बेडिंग मॉडल क्लाउड सेवा है। सिमेंटिक खोज सिर्फ़ इस कंप्यूटर के मॉडल उपयोग करती है।",
      "settings.data.encryptMemory.pending": "Linux हेल्पर से कुंजी की प्रतीक्षा में।",
      "settings.devices.touchId.none":
        "अभी कोई पासवर्ड कुंजी नहीं। जब तक कोई रजिस्टर नहीं होती, आपका पासवर्ड चाहने वाले कार्ड स्वीकृत नहीं हो सकते।",
      "settings.devices.touchId.noBundledKey":
        "इस ऐप के Linux हेल्पर के पास स्वीकृति कुंजी नहीं है ({reason})।",
      "settings.devices.touchId.manualHint":
        "कंप्यूटर पर psyche-helper --print-identity चलाएँ और जो presenceKeyId छपे उसे पेस्ट करें।",
      "settings.devices.noNodes":
        "कोई नोड नहीं। इस कंप्यूटर पर Psyche के चलने पर Linux हेल्पर यहाँ दिखाई देता है।",
      "settings.files.execHost": "इस कंप्यूटर पर कमांड चलाएँ",
      "settings.files.execHostSwitch": "इस कंप्यूटर पर कमांड की अनुमति दें",
      "settings.model.ram.tooSmall":
        "इस कंप्यूटर में {gb, number} GB है। लोकल मॉडल को कम से कम {min, number} GB चाहिए; इसके बजाय क्लाउड प्रदाता उपयोग करें।",
      "settings.model.ram.fits": "इस कंप्यूटर में {gb, number} GB है, इसलिए {fits} फ़िट होते हैं।",
      "settings.model.ram.thisMac": " (यह कंप्यूटर)",
      "settings.model.localHint": "Ollama या LM Studio से इस कंप्यूटर पर मॉडल चलाएँ।",
      "settings.permissions.never.browserPasswords": "ब्राउज़र या सिस्टम कीरिंग में सहेजे पासवर्ड पढ़ना",
      "settings.server.bindHint":
        "127.0.0.1 इसे इसी कंप्यूटर पर रखता है। हर इंटरफ़ेस से बाइंड करने के बजाय नीचे दिया गया रिमोट ऐक्सेस उपयोग करें।",
      "settings.gateways.description":
        "किसी दूसरे कंप्यूटर के Gateway के साथ, जैसे घर के आपके कंप्यूटर के साथ, इस कंप्यूटर से Psyche उपयोग करें। एक समय में एक ही Gateway सक्रिय होता है, और बदलने पर Psyche रीस्टार्ट होता है।",
      "settings.gateways.thisMac": "यह कंप्यूटर",
      "settings.gateways.switchKeep":
        "Psyche {name} पर रीस्टार्ट होता है। इस कंप्यूटर पर Psyche चलता रहता है, इसलिए उसके ऑटोमेशन जारी रहते हैं।",
      "settings.gateways.switchAndStop": "बदलें और इस कंप्यूटर पर Psyche रोकें",
      "settings.gateways.addHint":
        "Psyche चलाने वाले कंप्यूटर से पेयरिंग लिंक पेस्ट करें (सेटिंग्ज़, सर्वर और रिमोट एक्सेस, दूसरा कंप्यूटर पेयर करें)। लिंक के बिना, उसका Tailscale पता टाइप करें, https://<host>.<tailnet>.ts.net; फिर यह कंप्यूटर पेयर करने को कहता है, और मालिक वहाँ उसे स्वीकृत करता है।",
      "settings.gateways.problem.link_malformed":
        "वह पेयरिंग लिंक क्षतिग्रस्त है। उसे बनाने वाले कंप्यूटर से फिर कॉपी करें।",
      "settings.gateways.problem.link_bad_field":
        "वह पेयरिंग लिंक क्षतिग्रस्त है। उसे बनाने वाले कंप्यूटर से फिर कॉपी करें।",
      "settings.gateways.problem.link_lan":
        "यह पेयरिंग लिंक आपके लोकल नेटवर्क के किसी कंप्यूटर का है लेकिन उसमें उसका सर्टिफ़िकेट नहीं है, इसलिए उपयोग नहीं होता। उस कंप्यूटर पर नया बनाएँ: दूसरा कंप्यूटर पेयर करें, इस नेटवर्क से।",
      "settings.remote.description":
        "किसी दूसरे कंप्यूटर के Psyche को Tailscale के ज़रिए इस कंप्यूटर का Gateway उपयोग करने दें। Gateway इसी कंप्यूटर पर रहता है और सिर्फ़ उसी की सुनता है, और Tailscale Serve अंदर आने का एकमात्र रास्ता है।",
      "settings.remote.step1":
        "इस कंप्यूटर और दूसरे कंप्यूटर पर Tailscale इंस्टॉल करें, और दोनों को एक ही tailnet में साइन इन करें।",
      "settings.remote.step2":
        "इस कंप्यूटर पर टर्मिनल में Gateway को अपने tailnet पर प्रकाशित करें। यह Serve है, Funnel नहीं।",
      "settings.remote.step4":
        "Psyche रीस्टार्ट करें। फिर दूसरे कंप्यूटर पर इस कंप्यूटर को Gateway के रूप में जोड़ें। यह एक पेयरिंग कोड और कुंजी फ़िंगरप्रिंट दिखाता है: उन्हें यहाँ “पेयर होने की प्रतीक्षा में” के तहत अनुरोध से मिलाएँ, फिर स्वीकृत करें।",
      "settings.remote.admin":
        "पेयर होने वाले कंप्यूटर को पढ़ने, लिखने और स्वीकृतियों की पहुँच मिलती है। एडमिन तब तक बंद रहता है जब तक आप स्वीकृति देते समय उसे टिक न करें, और हर एडमिन बदलाव के लिए फिर भी यहाँ आपका पासवर्ड चाहिए।",
      "settings.pair.needsAddress":
        "पहले इस कंप्यूटर का सार्वजनिक पता सेट करें (ऊपर चरण 3), फिर पेयरिंग लिंक बनाएँ।",
      "settings.pair.adminHint":
        "एडमिन उसे सुरक्षा सेटिंग्ज़, डिवाइस और वॉल्ट बदलने देता है, और तब तक बंद रहता है जब तक आप उसे टिक न करें। हर एडमिन बदलाव के लिए फिर भी यहाँ आपका पासवर्ड चाहिए।",
      "settings.pair.compare":
        "लिंक उपयोग करने से पहले यह इस कंप्यूटर की कुंजी जाँचता है: {fingerprint}। आप मिला सकते हैं।",
      "settings.pair.secret":
        "अगले दस मिनट में जिसके पास भी यह लिंक होगा, वह एक कंप्यूटर पेयर कर सकता है। इसे पोस्ट न करें और ऐसे किसी को न भेजें जिस पर आप इस कंप्यूटर के लिए भरोसा नहीं करेंगे।",
      "settings.pair.err.noAddress":
        "इस कंप्यूटर का अभी कोई सार्वजनिक पता नहीं है, इसलिए लिंक में रखने को कुछ नहीं।",
      "settings.pair.viaAddress": "Tailscale के ज़रिए, इस कंप्यूटर के पते पर",
      "settings.pair.viaLanHint":
        "इस नेटवर्क का लिंक इस कंप्यूटर की कुंजी और सर्टिफ़िकेट रखता है, इसलिए यह सिर्फ़ उसी Wi-Fi या Ethernet के कंप्यूटरों के लिए काम करता है।",
      "settings.pair.lanNote":
        "यह लिंक इस कंप्यूटर वाले ही नेटवर्क के कंप्यूटरों के लिए है। यह उस कुंजी और सर्टिफ़िकेट का नाम देता है जिन पर Psyche अड़ा रहेगा।",
      "settings.lan.description":
        "उसी Wi-Fi या Ethernet पर किसी दूसरे कंप्यूटर के Psyche को Tailscale के बिना इस कंप्यूटर के Gateway तक पहुँचने दें। जब तक आप चालू नहीं करते, यह बंद रहता है।",
      "settings.lan.toggleHint":
        "Psyche एक नेटवर्क पर, अपने सर्टिफ़िकेट वाले एन्क्रिप्टेड कनेक्शन से सुनता है। कनेक्ट होने वाले कंप्यूटर को फिर भी यहाँ आपके पासवर्ड से स्वीकृत किया जाना ज़रूरी है।",
      "settings.lan.noInterface": "इस कंप्यूटर पर कोई Wi-Fi या Ethernet कनेक्शन नहीं मिला।",
      "settings.lan.notAdvertised": "नहीं दिखाया जाता। इस कंप्यूटर को उसके पते से जोड़ें।",
      "settings.lan.problem.unknownInterface": "{name} इस कंप्यूटर का कोई नेटवर्क नहीं है।",
      "settings.lan.problem.advertise":
        "Psyche नेटवर्क पर खुद को घोषित नहीं कर सका। कंप्यूटर फिर भी इस कंप्यूटर को उसके पते से जोड़ सकते हैं।",
      "settings.server.noVm":
        "कोई VM नहीं। VM मोड Psyche को एक अलग गेस्ट कंप्यूटर के अंदर चलाता है; इसे ऑनबोर्डिंग से सेट अप करें।",
      "settings.shortcut.key.Control": "Ctrl",
      "settings.shortcut.key.Alt": "Alt",
      "settings.skills.permission.exec_host": "इस कंप्यूटर पर कमांड चलाना",
      "settings.skills.permission.computer_action": "इस कंप्यूटर पर ऐप उपयोग करना",
      "settings.skills.pathPlaceholder": "/home/you/Downloads/pdf-merge",
      "settings.skills.signer.originAgent":
        "भेजने वाले के कंप्यूटर पर किसी असिस्टेंट ने लिखी। इसे बिना समीक्षा वाले टेक्स्ट की तरह पढ़ें, चाहे किसी ने भी हस्ताक्षर किए हों।",
      "settings.skills.export.hint":
        "फ़ाइल पर आपकी लेखक कुंजी से हस्ताक्षर होते हैं, ताकि जिन्हें यह मिले वे जान सकें कि यह आपकी है और बदली नहीं गई। कुंजी इसी कंप्यूटर पर रहती है।",
      "settings.vm.phase.installing": "गेस्ट सेट अप हो रहा है",
      "settings.vm.description":
        "टास्क को एक अलग सैंडबॉक्स कंप्यूटर में चलाएँ, ताकि {persona} आपके Linux के बजाय अपनी अलग प्रति में काम करे।",
      "settings.vm.sandboxMac": "सैंडबॉक्स कंप्यूटर",
      "settings.vm.between": "आपके कंप्यूटर और गेस्ट के बीच",
      "settings.vm.credentialsHint":
        "होस्ट वॉल्ट के साथ, मान आपके कंप्यूटर पर रहते हैं। गेस्ट वॉल्ट अपनी अलग प्रति रखता है।",
      "settings.vm.noReports":
        "अभी किसी गेस्ट ने रिपोर्ट नहीं किया। इस कंप्यूटर पर Psyche हेल्पर से एक बनाएँ; इसकी स्थिति यहाँ दिखती है।",
      "settings.voice.key.rightOption": "दायाँ Alt",
      "settings.voice.key.rightCommand": "दायाँ Ctrl",
      "settings.voice.reply.gatewayHint": "पर्सोना के लिए सेट की गई आवाज़, या सिस्टम आवाज़।",
      "settings.voice.engine.local": "इस कंप्यूटर पर",
      "settings.voice.engine.localHint": "Whisper लोकल चलता है; ऑडियो कभी कंप्यूटर से बाहर नहीं जाता।",
      "settings.voice.engine.system": "सिस्टम श्रुतलेख",
      "settings.voice.engine.systemHint": "Linux हेल्पर के ज़रिए सिस्टम का ऑन-डिवाइस पहचानकर्ता।",
      "settings.voice.model.usingHelper":
        "श्रुतलेख हेल्पर की स्पीच पहचान का उपयोग करता है। स्पीच मॉडल बेहतर ट्रांसक्रिप्शन करता है और इस कंप्यूटर पर चलता है।",
      "settings.voice.model.downloadHint":
        "whisper.cpp प्रोजेक्ट से एक बार का डाउनलोड, उपयोग से पहले जाँचा जाता है। ऑडियो कभी इस कंप्यूटर से बाहर नहीं जाता।",
      "settings.voice.model.ready": "इस कंप्यूटर पर Whisper ({model})",
      "settings.voice.model.readyHint":
        "श्रुतलेख और रिकॉर्डिंग यहीं ट्रांसक्राइब होती हैं; ऑडियो कभी कंप्यूटर से बाहर नहीं जाता।",
      "settings.connect.finishOpened":
        "{name} का साइन-इन Gateway के कंप्यूटर पर आपके ब्राउज़र में खुला। आपके पूरा करने पर यह अपडेट हो जाता है।",
      "settings.connect.needsPermission":
        "{name} सेट अप है, लेकिन सिस्टम ने अभी इसकी अनुमति नहीं दी है। इसकी अनुमति यहाँ दें:",
      "settings.connect.openSystemSettings": "सेटिंग्ज़ खोलें",
      "settings.people.description":
        "वे कार्ड जो {persona} आपके जीवन के लोगों और प्रोजेक्ट के लिए रखता है। ये इसी कंप्यूटर पर रहते हैं, और हर तथ्य दिखाता है कि वह कहाँ से आया।",
      "settings.about.versionsHint": "इस कंप्यूटर पर क्या चल रहा है।",
      "settings.computerUse.macPermissionsHint": "डेस्कटॉप ने क्या अनुमति दी है।",
      "settings.connectorBundle.sandbox.none":
        "इस कंप्यूटर में कमांड कनेक्टर के लिए कोई सैंडबॉक्स नहीं है, और Psyche कभी इन्हें उसके बाहर नहीं चलाता। यह कनेक्टर यहाँ इंस्टॉल नहीं हो सकता। कुछ भी शुरू या सहेजा नहीं गया।",
      "settings.connectorBundle.share.unavailable":
        "कनेक्टर पर हस्ताक्षर केवल उसी कंप्यूटर पर चल रहा Psyche कर सकता है जो उसे चलाता है।",
      "settings.deviceAccess.files.title": "इस कंप्यूटर पर फ़ाइलें",
      "settings.deviceAccess.terminal.hint":
        "जब अनुमतियाँ → एक्सेस में “इस कंप्यूटर पर कमांड चलाएँ” चालू हो, तो {persona} इस कंप्यूटर पर टर्मिनल कमांड चला सकता है।",
      "settings.deviceAccess.terminal.where":
        "कमांड आपके कंप्यूटर पर, आपके साझा किए फ़ोल्डर में चलते हैं, और सिर्फ़ उसी फ़ोल्डर में लिख सकते हैं जिसे आपने पढ़ने और लिखने के लिए साझा किया।",
      "settings.mcp.needs.title": "आपके कंप्यूटर पर इसे क्या चाहिए",
      "settings.mcp.needs.node.fix":
        "Psyche के अपने Node पर चलता है; इस कंप्यूटर पर npm चाहिए। nodejs.org से Node.js इंस्टॉल करें, या अपने पैकेज मैनेजर से।",
      "settings.mcp.needs.uv.fix": "एक Python सर्वर। uv को docs.astral.sh/uv से इंस्टॉल करें।",
      "settings.mcp.fail.node_missing":
        "Node.js इंस्टॉल करें (nodejs.org से, या अपने पैकेज मैनेजर से) ताकि इस कंप्यूटर पर npm हो, फिर दोबारा जाँचें।",
      "settings.mcp.fail.uv_missing": "uv इंस्टॉल करें (docs.astral.sh/uv), फिर सर्वर दोबारा जाँचें।",
      "settings.mail.voice.learn.hint":
        "Wren सिर्फ़ भेजे गए मेल में आपका लिखा हुआ पढ़ती है, उद्धृत टेक्स्ट और सिग्नेचर के बिना। प्रोफ़ाइल इसी कंप्यूटर पर mail/VOICE.md में रहती है।",
      "settings.mail.voice.localModel.hint": "आपकी शैली में बने ड्राफ़्ट कभी इस कंप्यूटर से बाहर नहीं जाते।",
      "settings.mail.transcribe.endpoint.hint":
        "वैकल्पिक। /v1/audio/transcriptions के लिए OpenAI-संगत सर्वर (जैसे इस कंप्यूटर पर whisper.cpp)। जब Linux हेल्पर के पास स्पीच इंजन न हो, तब इसका उपयोग होता है। ऑडियो केवल इसी पते पर जाता है: https, या 127.0.0.1 पर http।",
      "onboarding.mail.voiceHint":
        "सिर्फ़ आपका लिखा पढ़ती है, उद्धृत टेक्स्ट और सिग्नेचर के बिना। यह इसी कंप्यूटर पर रहता है और आप इसे देख, बदल या रीसेट कर सकते हैं।",
      "gallery.preset.git.field.repo.help":
        "इस कंप्यूटर पर किसी Git रिपॉज़िटरी का फ़ोल्डर। Psyche उसका इतिहास और अंतर पढ़ सकता है।",
      "settings.connectors.page.onThisMac": "इस कंप्यूटर पर",
      "settings.connectors.page.row.local": "इस कंप्यूटर पर चलता है",
      "settings.connectors.page.server.local": "एक टूल जो इस कंप्यूटर पर सैंडबॉक्स में चलता है",
      "onboarding.permission.denied": "सेटिंग्ज़ में बंद",
      "onboarding.permission.deniedHint":
        "इसे अपने सिस्टम की सेटिंग्ज़ में चालू करें; आपके वापस आने पर यह पेज अपडेट हो जाता है।",
      "onboarding.permission.unavailableHint": "Psyche इसे केवल Psyche डेस्कटॉप ऐप में माँग सकता है।",
      "onboarding.connectors.onThisMac": "इस कंप्यूटर पर",
      "onboarding.connectors.onThisMacHint": "हर ऐप कनेक्ट होते समय सिस्टम से अनुमति मांगता है, एक-एक करके।",
      "onboarding.model.kind.localHint": "इसी कंप्यूटर पर चलता है; कुछ भी बाहर नहीं जाता।",
      "onboarding.model.subscriptionNote":
        "Psyche इस कंप्यूटर पर पहले से साइन इन किए गए Claude Code या Codex ऐप का उपयोग करता है, इसलिए इसे कोई API कुंजी नहीं चाहिए और यह कोई संग्रहीत नहीं करता। अगर आपने अभी तक नहीं किया है, तो पहले वहाँ साइन इन करें।",
      "onboarding.safety.touchId": "स्वीकृतियों के लिए आपका पासवर्ड",
      "onboarding.safety.touchId.checking": "Linux हेल्पर देखा जा रहा है…",
      "onboarding.safety.touchId.setHint":
        "जिन स्वीकृतियों में आपकी ज़रूरत होती है, वे आपका पासवर्ड मांगती हैं।",
      "onboarding.safety.touchId.starting": "Linux हेल्पर अभी शुरू हो रहा है। थोड़ी देर में फिर जाँचें।",
      "onboarding.safety.touchId.noKey": "Linux हेल्पर के पास स्वीकृति कुंजी नहीं है ({reason})।",
      "onboarding.safety.touchId.hint":
        "Linux हेल्पर की कुंजी एक बार रजिस्टर करें, ताकि आपका पासवर्ड स्वीकृतियों की पुष्टि कर सके।",
      "onboarding.safety.asks":
        "अगर आप {name} को इस कंप्यूटर पर कमांड चलाने देते हैं, तो जो सिर्फ़ पढ़ते हैं, जैसे ls या cat, वे बिना कार्ड के चलते हैं। बाकी सब पहले आपसे पूछता है।",
      "onboarding.done.touchId": "आपका पासवर्ड",
      "onboarding.done.try.search":
        "खोज (Ctrl+K) में कोई सवाल पूछें। जवाब दिखाता है कि वह आपके जीवन के किस हिस्से से आया।",
      "screens.search.source.revealFile": "फ़ाइलें में दिखाएँ",
      "everything.model.localHint":
        "इस कंप्यूटर पर एक मॉडल सब कुछ पढ़ता है। कंप्यूटर से कुछ बाहर नहीं जाता। कम और ज़्यादा अस्पष्ट तथ्य।",
      "everything.run.reason.battery":
        "अभी नहीं: कंप्यूटर बैटरी पर है। उसे चार्जर से लगाएँ या बैटरी पर रन की अनुमति दें।",
      "everything.run.reason.thermal": "अभी नहीं: कंप्यूटर बहुत गर्म है।",
      "everything.run.reason.not_idle": "अभी नहीं: आप कंप्यूटर इस्तेमाल कर रहे हैं।",
      "everything.storage.note": "सब कुछ सिर्फ़ इसी कंप्यूटर पर सेव होता है।",
      "memoryWork.consent.k1":
        "इस कंप्यूटर से कुछ बाहर नहीं जाता। तारीखें और स्थिति कोड द्वारा निकाली जाती हैं।",
      "screens.library.reveal": "फ़ाइलें में दिखाएँ",
      "web.zoom.description":
        "इस कंप्यूटर पर ऐप कितना बड़ा दिखता है। Ctrl+Plus और Ctrl+Minus इसी सेटिंग को बदलते हैं, इसलिए यह रीस्टार्ट के बाद भी बनी रहती है; {min, number}–{max, number} %।",
      "web.transcriptMode.optionTitle": "{mode} (Ctrl+O से बदलें)",
      "web.backups.restore": "Gateway बंद करके नए कंप्यूटर पर रीस्टोर करें:",
      "web.passkeys.firstApproval":
        "“पासकी जोड़ें” को अपने कंप्यूटर पर अपने पासवर्ड से या किसी दूसरे डिवाइस पर पासकी से स्वीकृत करें, फिर जोड़ें को फिर से दबाएँ।",
      "web.passkeys.added":
        "{name} जोड़ी गई। अब यह उन बदलावों को स्वीकृत करती है जिन्हें आपका पासवर्ड या पासकी चाहिए।",
      "web.remotePresence.title": "स्वीकृतियों के लिए आपका पासवर्ड",
      "web.remotePresence.description":
        "खरीदारी, क्रेडेंशियल भरना, होस्ट कमांड और सुरक्षा बदलावों के लिए आपका पासवर्ड या पासकी चाहिए। यहाँ जवाब देने के लिए इसे इस कंप्यूटर पर सेट अप करें; तब तक वे कार्ड {host} पर जवाब देने को कहते हैं। सामान्य स्वीकृतियों को इसकी कभी ज़रूरत नहीं होती।",
      "web.remotePresence.on": "इस कंप्यूटर के लिए पासवर्ड स्वीकृतियाँ चालू हैं।",
      "web.remotePresence.off": "इस कंप्यूटर पर पासवर्ड स्वीकृतियाँ सेट अप नहीं हैं।",
      "web.remotePresence.enable": "इस कंप्यूटर पर स्वीकृतियों के लिए अपना पासवर्ड उपयोग करें",
      "web.remotePresence.waiting": "आपके पासवर्ड की प्रतीक्षा में…",
      "web.remotePresence.passkeyName": "इस कंप्यूटर पर आपका पासवर्ड",
      "web.remotePresence.enabled": "इस कंप्यूटर के लिए पासवर्ड स्वीकृतियाँ चालू हैं।",
      "web.remotePresence.disabled": "इस कंप्यूटर पर पासवर्ड स्वीकृतियाँ बंद हैं।",
      "web.remotePresence.approveOnHost":
        "{host} पर उसके Touch ID, Windows Hello या पासवर्ड से, या पासकी से “पासकी जोड़ें” को स्वीकृत करें, फिर बटन दोबारा दबाएँ।",
      "web.remotePresence.unavailable":
        "पासवर्ड स्वीकृतियों के लिए {host} का Gateway https:// पते पर होना चाहिए (gateway.publicOrigin)। तब तक उन कार्डों का जवाब {host} पर दें।",
      "web.webauthn.noPasskeyYet":
        "इस ब्राउज़र में अभी कोई पासकी नहीं है। सेटिंग्ज़ → डिवाइस और नोड में एक जोड़ें, या Gateway चलाने वाले कंप्यूटर पर स्वीकृत करें।",
      "web.webauthn.needsOrigin":
        "पासकी के लिए सर्वर का https पता (gateway.publicOrigin) चाहिए। इसके बजाय Gateway चलाने वाले कंप्यूटर पर स्वीकृत करें।",
      "web.setup.gatewayOk": "इस कंप्यूटर पर चल रहा है।",
      "web.setup.adminOk": "यह कंप्यूटर ऐडमिन डिवाइस है।",
      "web.viewers.noSandbox":
        "स्लाइड के प्रीव्यू के लिए सैंडबॉक्स चाहिए, और कोई कंटेनर रनटाइम (Docker या Podman) उपलब्ध नहीं है।",
      "web.voice.noEngine":
        "कोई स्पीच इंजन उपलब्ध नहीं है। सेटिंग्ज़ → आवाज़ में स्पीच मॉडल इंस्टॉल करें, या Linux हेल्पर कनेक्ट करें।",
      "web.threads.newSideChatTitle": "नई साइड चैट (Ctrl+N)",
      "web.panes.closePaneTitle": "पेन बंद करें (Ctrl+\\)",
      "web.chat.permissionModeTitle": "अनुमति मोड (Ctrl+Shift+M)",
      "web.chat.modelTitle": "मॉडल (Ctrl+Shift+I)",
      "web.splash.installing": "इस कंप्यूटर पर Psyche सेट अप हो रहा है…",
      "web.splash.helper": "आपके कंप्यूटर पर Psyche तैयार हो रहा है…",
      "web.splash.remote.useThisMac": "इस कंप्यूटर का उपयोग करें",
      "web.remote.thisMac": "यह कंप्यूटर",
      "web.teach.bar.body":
        "Psyche सिर्फ़ इसी टैब में आपके क्लिक और टाइपिंग नोट करता है। पासवर्ड, कार्ड नंबर और कोड कभी रिकॉर्ड नहीं होते, और आपके सेव करने तक कुछ इस कंप्यूटर से बाहर नहीं जाता।",
      "settings.teach.storage.description":
        "जब आप Psyche से कोई रिकॉर्डिंग रखने को कहते हैं ताकि आप एक और संस्करण बना सकें, तो चरण इसी कंप्यूटर पर सेव होते हैं।",
      "settings.teach.storage.encrypted":
        "एन्क्रिप्टेड। फ़ाइल सिस्टम कीरिंग में रखी कुंजी से लॉक है, इसलिए Psyche के बाहर नहीं पढ़ी जा सकती। यह 90 दिन बाद समाप्त होती है।",
      "settings.teach.storage.unavailable":
        "रिकॉर्डिंग नहीं रखी जातीं। सिस्टम कीरिंग उपलब्ध नहीं है, और Psyche रिकॉर्डिंग को सादे टेक्स्ट में सेव नहीं करेगा। आप फिर भी रिकॉर्डिंग को स्किल के रूप में सेव कर सकते हैं।",
      "web.teach.review.keepUnavailable":
        "उपलब्ध नहीं: रखी गई रिकॉर्डिंग को एन्क्रिप्ट करने के लिए सिस्टम कीरिंग उपलब्ध नहीं है।",
      "web.teach.review.keepRecording": "इस रिकॉर्डिंग को इस कंप्यूटर पर रखें ताकि मैं एक और संस्करण बना सकूँ",
      "web.teach.app.recordHint":
        "Psyche को दिखाएँ कि आपके पहले से अनुमति दिए गए किसी ऐप में कोई काम कैसे करना है",
      "web.teach.app.bar.body":
        "Psyche केवल {app} में आपके क्लिक, मेनू के चुनाव और टाइपिंग नोट करता है। सुरक्षित फ़ील्ड कभी रिकॉर्ड नहीं होते, कोई स्क्रीनशॉट नहीं लिया जाता, और आपके सहेजने तक कुछ भी इस कंप्यूटर से बाहर नहीं जाता। सिस्टम ट्रे में भी एक रोकें बटन है।",
      "voice.key.rightOption": "दायाँ Alt",
      "voice.key.rightCommand": "दायाँ Ctrl",
      "voice.settings.reviewHint":
        "Psyche ने जो सुना उसे पॉप-अप में रखता है, ताकि आप उसे ठीक करके Enter दबा सकें। बंद होने पर, कुंजी छोड़ते ही भेज दिया जाता है।",
      "meetingRecord.unavailable":
        "रिकॉर्डिंग के लिए ऑडियो को नोट्स में बदलने का तरीका (स्पीच मॉडल या Linux हेल्पर) चाहिए, और कोई कनेक्ट नहीं है।",
      "meetingRecord.micDenied":
        "Psyche माइक्रोफ़ोन का उपयोग नहीं कर सकता। इसे अपने सिस्टम की सेटिंग्ज़ में अनुमति दें।",
      "platform.term.os": "Linux",
      "platform.term.device": "कंप्यूटर",
      "platform.term.thisDevice": "यह कंप्यूटर",
      "platform.term.thisDeviceLower": "यह कंप्यूटर",
      "platform.term.presence": "आपका पासवर्ड",
      "platform.term.secretStore": "सिस्टम कीरिंग",
      "platform.term.systemSettings": "सेटिंग्ज़",
      "platform.term.fileManager": "फ़ाइलें",
      "platform.term.trayArea": "सिस्टम ट्रे",
      "platform.term.taskbar": "टास्कबार",
      "platform.term.systemSearch": "डेस्कटॉप खोज",
      "platform.term.helper": "Linux हेल्पर",
      "platform.term.terminal": "टर्मिनल",
      "platform.term.alt": "Alt",
      "platform.term.mod": "Ctrl",
      "web.security.banner.recovery":
        "{count, plural, one {इस कंप्यूटर पर माँगा गया एक सुरक्षा बदलाव {when} को लागू होगा, जब तक आप इसे रद्द न करें।} other {इस कंप्यूटर पर माँगे गए # सुरक्षा बदलाव प्रतीक्षा में हैं। अगला {when} को लागू होगा।}}",
      "web.security.alert.changed":
        "इस कंप्यूटर पर एक प्रोग्राम ने Psyche के बिना {count, plural, one {1 सुरक्षा रिकॉर्ड} other {# सुरक्षा रिकॉर्ड}} बदल दिए। Psyche ने {count, plural, one {उसे} other {उन्हें}} वापस पहले जैसा कर दिया। अगर यह आपने नहीं किया, तो कंप्यूटर में अनचाहे सॉफ़्टवेयर की जाँच करें।",
      "web.security.alert.untrusted":
        "Psyche के सुरक्षा रिकॉर्ड की जाँच विफल रही। नए डिवाइस, सुरक्षा सेटिंग्स और पासवर्ड से मंज़ूरी रोक दी गई हैं। अपने डिवाइस देखें, फिर कंप्यूटर पर psyched security reseal चलाएँ; यह 24 घंटे बाद लागू होता है।",
      "web.security.alert.firstAdmin":
        "इस कंप्यूटर पर एक कमांड ने {name} को पहला एडमिन डिवाइस बना दिया। अगर यह आपने नहीं किया, तो उसे डिवाइस में रद्द करें।",
      "web.security.alert.requested": "इस कंप्यूटर पर माँगा गया: {action} {when} को लागू होगा।",
      "web.security.op.presenceReset":
        "नई कुंजी दर्ज होने तक सुरक्षा बदलावों के लिए आपका पासवर्ड या पासकी न माँगना।",
      "web.security.needsApproval": "अपने पासवर्ड या पासकी से कार्ड को मंज़ूरी दें, फिर बटन दोबारा दबाएँ।",
    },
    it: {
      "settings.devices.nodeKind.hostHelper": "Assistente Linux",
      "settings.links.description":
        "Dove si apre un link in un messaggio, una scheda o un artefatto. Ctrl+clic usa sempre il browser predefinito.",
      "errors.presence_required":
        "Prima conferma la tua identità con la tua password o con una passkey.",
      "chat.toolbar.keySheet": "Ctrl+Shift+A",
      "chat.toolbar.keyModel": "Ctrl+Shift+I",
      "chat.toolbar.keyView": "Ctrl+O",
      "chat.approval.keysHint": "Ctrl+Enter {allows} · Ctrl+D {denies}",
      "blocks.details.runsOnHost": "sul tuo computer, fuori dalla sandbox",
      "blocks.details.runsSandboxed":
        "sul tuo computer, nella sandbox: non può leggere il vault di Psyche, le tue chiavi SSH, il portachiavi di sistema né i profili del browser",
      "blocks.details.runsNoSandbox": "sul tuo computer, e la sandbox non è configurata ({reason})",
      "blocks.permission.need.capability": "Attiva “Esegui comandi su questo computer”",
      "blocks.permission.need.macos_access": "Dai accesso a {connector} nelle Impostazioni",
      "blocks.permission.openSystemSettings": "Apri Impostazioni",
      "blocks.approval.answerOnHost":
        "Rispondi su {host}, oppure configura le approvazioni con password per questo computer in Impostazioni → Dispositivi.",
      "blocks.approval.needsAuth": "Per approvare serve la tua password o una passkey.",
      "blocks.approval.touchIdFailed": "Verifica della password non riuscita: {reason}. Riprova.",
      "blocks.approval.touchIdFailedNoReason": "Verifica della password non riuscita. Riprova.",
      "blocks.approval.touchId.helperOffline":
        "L’helper per Linux non è in esecuzione, quindi la tua password non può confermare da qui.",
      "blocks.approval.touchId.noKey":
        "Le approvazioni con password non sono ancora configurate su questo computer. Configurale in Impostazioni → Dispositivi, dove puoi prima verificare la chiave.",
      "blocks.approval.touchId.invalidated":
        "La configurazione della tua password è cambiata dopo la configurazione della chiave di questo computer, quindi non può confermare le approvazioni. Configurala di nuovo in Impostazioni → Dispositivi.",
      "blocks.approval.touchId.noUnsandboxed":
        "Eseguire un comando senza sandbox non può essere approvato con la tua password da questa finestra. Configura invece la sandbox",
      "blocks.approval.touchId.onceOnly":
        "le approvazioni con password da questa finestra valgono una sola volta.",
      "blocks.approval.status.allowedOnceTouchId":
        "Consentito una volta (le approvazioni con password da questa finestra valgono una sola volta)",
      "blocks.approval.touchId.keyUnavailable":
        "Questa build dell’helper per Linux non può conservare una chiave di approvazione, quindi le schede che richiedono la tua password non possono essere approvate su questo computer.",
      "blocks.approval.touchId.cancelled":
        "La richiesta della password è stata annullata, quindi non è stato approvato nulla",
      "shell.shortcut.pushToTalkKeys": "Tieni premuto Ctrl destro",
      "settings.shared.needsPresence":
        "La modifica di “{label}” richiede la tua approvazione con la tua password o una passkey. Approvala nelle Impostazioni o nella notifica di Psyche, poi modificala di nuovo.",
      "settings.page.permissions.description":
        "Cosa {persona} può fare su questo computer senza chiedere, e dove si ferma sempre a chiederti.",
      "settings.page.data.description":
        "Cosa resta su questo computer, per quanto tempo viene conservato, esportazioni, backup e ripartire da zero.",
      "settings.essentials.model.noneHint":
        "{persona} ha bisogno di un modello per poter rispondere. Aggiungi una chiave, oppure usa un modello su questo computer.",
      "settings.essentials.read.hint":
        "Disattivato finché non ne attivi uno. Ciò che legge viene indicizzato su questo computer per trovare le cose al posto tuo, e anche la memoria impara da esso, a meno che tu non lo escluda in Memoria → Fonti.",
      "settings.searchModel.apple.notOnThisMac": "Disponibile su macOS",
      "settings.macHelper.paired.text":
        "Gestisce uso del computer, contesto dello schermo, dettatura, approvazioni con password e notifiche su questo computer.",
      "settings.macHelper.unbundled.text":
        "Questa versione di Psyche non include l’helper per Linux.",
      "settings.key.appearance.showInDock":
        "Mostra nella barra delle applicazioni quando non ci sono finestre aperte",
      "settings.semanticSearch.encrypt.pending":
        "In attesa che l’helper per Linux apra l’indice cifrato",
      "settings.semanticSearch.rerankHint":
        "Un piccolo modello cloud mette i risultati migliori in cima. I primi 20 frammenti lasciano questo computer. Disattivato per impostazione predefinita.",
      "settings.key.vm.enabled": "Usa un computer sandbox per le attività",
      "settings.key.vm.resetPerTask": "Un computer nuovo per ogni attività",
      "settings.credentials.backend.psyche": "Cassaforte di Psyche (la tua password)",
      "settings.credentials.backend.keychain": "Portachiavi di sistema",
      "settings.credentials.backendIn.keychain": "nel portachiavi di sistema",
      "settings.credentials.err.lockedChange":
        "La cassaforte è bloccata. Sbloccala con la tua password, poi {verb, select, delete {elimina} other {modifica}} di nuovo {name}.",
      "settings.credentials.err.lockedImport":
        "La cassaforte è bloccata. Sbloccala con la tua password, poi importa di nuovo.",
      "settings.credentials.slot.keychain": "il portachiavi di sistema (la tua password)",
      "settings.credentials.slot.safeStorage": "l’archivio dell’app su questo computer",
      "settings.credentials.slot.keyFile": "un file chiave su questo computer",
      "settings.credentials.moveToKeychain": "Sposta nel portachiavi di sistema",
      "settings.credentials.keyFileExplainer":
        "La chiave che apre la cassaforte è un file che solo il tuo account può leggere. Spostarla nel portachiavi di sistema richiede l’helper per Linux; l’helper di questa versione non è disponibile.",
      "settings.credentials.link.err.locked":
        "La cassaforte è bloccata. Sbloccala con la tua password, poi collega di nuovo {name}.",
      "settings.approval.presenceUnavailable":
        "Questa finestra non può confermare che sei tu. Approva la modifica nell’app Psyche sul tuo computer (la tua password), oppure da un dispositivo con una passkey. Fino ad allora non cambia nulla.",
      "settings.approval.promptDetail":
        "Le impostazioni di sicurezza richiedono la tua password o una passkey. Approvala qui o nella notifica di Psyche; l’impostazione viene salvata non appena approvata.",
      "settings.approval.presenceInvalid":
        "La tua password o la passkey non hanno confermato la tua identità. Riprova.",
      "settings.about.revealHome": "Mostra in File",
      "settings.uninstall.keychainStays":
        "Gli elementi del portachiavi di sistema restano (la chiave della cassaforte e quelli dell’helper). Rimuovili nella tua app per il portachiavi se vuoi.",
      "settings.uninstall.keychainGoes":
        "Vengono rimossi anche gli elementi del portachiavi di sistema per la cassaforte e l’helper.",
      "settings.uninstall.removeKeychain":
        "Rimuovi anche i miei elementi del portachiavi di sistema (quelli di Psyche). Senza i tuoi dati sono inutili.",
      "settings.uninstall.presence":
        "Ti verrà poi chiesto di confermare con la tua password o su questo dispositivo, perché così i tuoi dati vengono rimossi.",
      "settings.appearance.showInDockHint":
        "Se disattivato, Psyche continua a funzionare nell’area di notifica quando si chiude l’ultima finestra.",
      "settings.appearance.openAtLoginHint":
        "Avvia Psyche nell’area di notifica quando accedi, così le automazioni pianificate possono sempre essere eseguite.",
      "settings.browser.letTasksUseHint":
        "Ogni attività te lo chiede comunque prima, su questo dispositivo con la tua password o una passkey.",
      "settings.browser.detailsText":
        "Mentre un’attività lo usa, Psyche esegue Google Chrome con questo profilo e una porta DevTools sul loopback di questo computer (127.0.0.1), e lo chiude al termine dell’attività. {persona} non è collegato mentre tieni aperto tu il profilo.",
      "settings.browser.openFromMac": "Aprilo dall’app Psyche sul computer che esegue il Gateway.",
      "settings.channels.empty":
        "Ancora nessun canale. Collega Telegram o Slack per contattare {persona} lontano da questo computer.",
      "settings.computerUse.description":
        "{persona} può usare le app su questo computer solo dove lo consenti.",
      "settings.computerUse.macPermissions": "Permessi del desktop",
      "settings.computerUse.openSystemSettingsFor": "Apri Impostazioni per {name}",
      "settings.computerUse.openSystemSettings": "Apri Impostazioni",
      "settings.trusted.loading": "Lettura da questo computer…",
      "settings.trusted.noHelper": "Apri Psyche sul tuo computer per elencarli: li legge l’helper.",
      "settings.trusted.failed": "Psyche non è riuscito a leggerli da questo computer.",
      "settings.mcp.sandboxHelp": "I server di comandi richiedono una sandbox su questo computer.",
      "settings.sandbox.why":
        "I comandi vengono eseguiti sul tuo computer con i tuoi file, ma non possono leggere il tuo vault, le chiavi né i dati privati di Psyche.",
      "settings.sandbox.whyHow":
        "Usa srt, il runtime sandbox di Anthropic, con la sandbox integrata di Linux (bubblewrap). Non serve alcuna macchina virtuale.",
      "settings.sandbox.checking": "Controllo di questo computer…",
      "settings.sandbox.containers.body":
        "Un runtime di container esegue il codice in una propria macchina Linux senza accesso ai file del tuo computer: per il codice eseguito dall’agente e per alcune conversioni di file. I server di comandi continuano a usare srt a meno che il Gateway non sia impostato per usare i container.",
      "settings.searchSources.description":
        "Cosa Psyche legge nel tuo indice di ricerca. Tutto disattivato finché non lo attivi; l’indice resta su questo computer. Attivare una fonte permette anche alla memoria di imparare da essa, a meno che tu non la escluda in Memoria → Fonti (Memoria e Contatti sono eccezioni: da nessuna delle due si impara).",
      "settings.searchSources.runOnBatteryHint":
        "Permette a indicizzazione, ricostruzione e lettura del testo nelle immagini di proseguire mentre il computer è a batteria, a ritmo più lento. Consuma più batteria. Il Risparmio energetico mette comunque in pausa l’indicizzazione.",
      "settings.searchSources.ocrHint":
        "Legge screenshot e PDF scansionati, una pagina alla volta, con alimentazione collegata (o a batteria se “Indicizza a batteria” è attivo). Nulla lascia il tuo computer.",
      "settings.semanticSearch.description":
        "Trova le cose per significato oltre che per parole, tutto su questo computer.",
      "settings.semanticSearch.engine.builtinHint":
        "Multilingual E5 small, circa 100 lingue, gira sul processore di questo computer.",
      "settings.semanticSearch.engine.routerHint":
        "Usa il modello di embedding impostato in Ruoli, ad esempio Ollama o LM Studio su questo computer.",
      "settings.semanticSearch.allowCloudHint":
        "Solo se il modello di embedding è un servizio cloud. Le tue chat, attività e il testo della Libreria gli vengono inviati. Se disattivato, tutto resta su questo computer.",
      "settings.semanticSearch.state.cloudBlocked":
        "Il modello di embedding in Ruoli è un servizio cloud. La ricerca semantica usa solo modelli su questo computer.",
      "settings.data.encryptMemory.pending": "In attesa della chiave dall’helper per Linux.",
      "settings.devices.touchId.none":
        "Ancora nessuna chiave password. Le schede che richiedono la tua password non possono essere approvate finché non ne registri una.",
      "settings.devices.touchId.noBundledKey":
        "L’helper per Linux in questa app non ha una chiave di approvazione ({reason}).",
      "settings.devices.touchId.manualHint":
        "Esegui psyche-helper --print-identity sul computer e incolla il presenceKeyId che stampa.",
      "settings.devices.noNodes":
        "Nessun nodo. L’helper per Linux compare qui quando Psyche è in esecuzione su questo computer.",
      "settings.files.execHost": "Esegui comandi su questo computer",
      "settings.files.execHostSwitch": "Consenti comandi su questo computer",
      "settings.model.ram.tooSmall":
        "Questo computer ha {gb, number} GB. I modelli locali richiedono almeno {min, number} GB; usa invece un fornitore cloud.",
      "settings.model.ram.fits": "Questo computer ha {gb, number} GB, quindi ci stanno {fits}.",
      "settings.model.ram.thisMac": " (questo computer)",
      "settings.model.localHint": "Esegui i modelli su questo computer con Ollama o LM Studio.",
      "settings.permissions.never.browserPasswords":
        "Leggere le password salvate nei browser o nel portachiavi di sistema",
      "settings.server.bindHint":
        "127.0.0.1 lo mantiene su questo computer. Usa l’accesso remoto qui sotto invece di metterlo in ascolto su tutte le interfacce.",
      "settings.gateways.description":
        "Usa Psyche da questo computer con il Gateway di un altro, ad esempio il tuo computer a casa. Un solo Gateway è attivo alla volta, e cambiarlo riavvia Psyche.",
      "settings.gateways.thisMac": "Questo computer",
      "settings.gateways.switchKeep":
        "Psyche si riavvia su {name}. Psyche su questo computer continua a funzionare, quindi le sue automazioni proseguono.",
      "settings.gateways.switchAndStop": "Cambia e ferma Psyche su questo computer",
      "settings.gateways.addHint":
        "Incolla il link di abbinamento dal computer che esegue Psyche (Impostazioni, Server e accesso remoto, Abbina un altro computer). Senza link, digita il suo indirizzo Tailscale, https://<host>.<tailnet>.ts.net; questo computer chiede di abbinarsi e il proprietario lo approva lì.",
      "settings.gateways.problem.link_malformed":
        "Quel link di abbinamento è danneggiato. Copialo di nuovo dal computer che lo ha creato.",
      "settings.gateways.problem.link_bad_field":
        "Quel link di abbinamento è danneggiato. Copialo di nuovo dal computer che lo ha creato.",
      "settings.gateways.problem.link_lan":
        "Questo link di abbinamento è per un computer della tua rete locale ma non include il suo certificato, quindi non viene usato. Su quel computer, creane uno nuovo: Abbina un altro computer, Da questa rete.",
      "settings.remote.description":
        "Lascia che Psyche su un altro computer usi il Gateway di questo computer tramite Tailscale. Il Gateway resta su questo computer e ascolta solo Tailscale Serve, che è l’unico accesso.",
      "settings.remote.step1":
        "Installa Tailscale su questo computer e sull’altro computer, e accedi a entrambi con la stessa tailnet.",
      "settings.remote.step2":
        "In un terminale su questo computer, pubblica il Gateway sulla tua tailnet. Questo è Serve, non Funnel.",
      "settings.remote.step4":
        "Riavvia Psyche. Poi, sull’altro computer, aggiungi questo computer come Gateway. Mostra un codice di abbinamento e l’impronta di una chiave: confrontali con la richiesta in “In attesa di abbinamento” qui, poi approvala.",
      "settings.remote.admin":
        "Un computer che si abbina ottiene lettura, scrittura e approvazioni. L’amministrazione resta disattivata a meno che tu non la selezioni durante l’approvazione, e ogni modifica di amministrazione richiede comunque la tua password qui.",
      "settings.pair.needsAddress":
        "Imposta prima l’indirizzo pubblico di questo computer (passaggio 3 qui sopra), poi crea un link di abbinamento.",
      "settings.pair.adminHint":
        "L’amministrazione gli permette di modificare impostazioni di sicurezza, dispositivi e vault, e resta disattivata a meno che tu non la selezioni. Ogni modifica di amministrazione richiede comunque la tua password qui.",
      "settings.pair.compare":
        "Controlla la chiave di questo computer prima di usare il link: {fingerprint}. Puoi confrontarla.",
      "settings.pair.secret":
        "Chiunque abbia questo link nei prossimi dieci minuti può abbinare un computer. Non pubblicarlo né inviarlo a chi non fiderebbe con questo computer.",
      "settings.pair.err.noAddress":
        "Questo computer non ha ancora un indirizzo pubblico, quindi non c’è nulla da mettere in un link.",
      "settings.pair.viaAddress": "Tramite Tailscale, all’indirizzo di questo computer",
      "settings.pair.viaLanHint":
        "Un link per questa rete contiene la chiave e il certificato di questo computer, quindi funziona solo per i computer sullo stesso Wi-Fi o Ethernet.",
      "settings.pair.lanNote":
        "Questo link è per i computer sulla stessa rete di questo computer. Indica la chiave e il certificato che Psyche pretenderà.",
      "settings.lan.description":
        "Permetti a Psyche su un altro computer sullo stesso Wi-Fi o Ethernet di raggiungere il Gateway di questo computer, senza Tailscale. È disattivato finché non lo attivi.",
      "settings.lan.toggleHint":
        "Psyche resta in ascolto su una rete, tramite una connessione cifrata con un proprio certificato. Un computer che si collega deve comunque essere approvato qui con la tua password.",
      "settings.lan.noInterface":
        "Su questo computer non è stata trovata alcuna connessione Wi-Fi o Ethernet.",
      "settings.lan.notAdvertised":
        "Non mostrato. Aggiungi questo computer tramite il suo indirizzo.",
      "settings.lan.problem.unknownInterface": "{name} non è una rete di questo computer.",
      "settings.lan.problem.advertise":
        "Psyche non è riuscito ad annunciarsi sulla rete. I computer possono comunque aggiungere questo computer tramite il suo indirizzo.",
      "settings.server.noVm":
        "Nessuna VM. La modalità VM esegue Psyche in un computer guest separato; configurala dalla configurazione iniziale.",
      "settings.shortcut.key.Control": "Ctrl",
      "settings.shortcut.key.Alt": "Alt",
      "settings.skills.permission.exec_host": "Eseguire comandi su questo computer",
      "settings.skills.permission.computer_action": "Usare le app su questo computer",
      "settings.skills.pathPlaceholder": "/home/tu/Downloads/pdf-merge",
      "settings.skills.signer.originAgent":
        "Scritta da un assistente sul computer del mittente. Leggila come testo non rivisto, chiunque l’abbia firmata.",
      "settings.skills.export.hint":
        "Il file è firmato con la tua chiave d’autore, così chi lo riceve può capire che è tuo e che non è stato modificato. La chiave resta su questo computer.",
      "settings.vm.phase.installing": "Configurazione del guest",
      "settings.vm.description":
        "Esegui le attività in un computer sandbox separato, così {persona} lavora in una propria copia di Linux invece che nella tua.",
      "settings.vm.sandboxMac": "Computer sandbox",
      "settings.vm.between": "Tra il tuo computer e il guest",
      "settings.vm.credentialsHint":
        "Con il vault dell’host, i valori restano sul tuo computer. Un vault del guest tiene una copia propria.",
      "settings.vm.noReports":
        "Nessun guest ha ancora inviato segnalazioni. Creane uno dall’helper di Psyche su questo computer; il suo stato compare qui.",
      "settings.voice.key.rightOption": "Alt destro",
      "settings.voice.key.rightCommand": "Ctrl destro",
      "settings.voice.reply.gatewayHint":
        "La voce impostata per la persona, oppure la voce di sistema.",
      "settings.voice.engine.local": "Su questo computer",
      "settings.voice.engine.localHint":
        "Whisper viene eseguito in locale; l’audio non lascia mai il computer.",
      "settings.voice.engine.system": "Dettatura di sistema",
      "settings.voice.engine.systemHint":
        "Il riconoscimento sul dispositivo del sistema, tramite l’helper per Linux.",
      "settings.voice.model.usingHelper":
        "La dettatura usa il riconoscimento vocale dell’helper. Il modello vocale trascrive meglio e viene eseguito su questo computer.",
      "settings.voice.model.downloadHint":
        "Un download una tantum dal progetto whisper.cpp, verificato prima dell’uso. L’audio non lascia mai questo computer.",
      "settings.voice.model.ready": "Whisper ({model}) su questo computer",
      "settings.voice.model.readyHint":
        "Dettatura e registrazioni vengono trascritte qui; l’audio non lascia mai il computer.",
      "settings.connect.finishOpened":
        "L’accesso a {name} si è aperto nel browser sul computer del Gateway. Questa pagina si aggiorna quando hai finito.",
      "settings.connect.needsPermission":
        "{name} è configurato, ma il sistema non l’ha ancora autorizzato. Autorizzalo in",
      "settings.connect.openSystemSettings": "Apri Impostazioni",
      "settings.people.description":
        "Le schede che {persona} tiene per le persone e i progetti della tua vita. Restano su questo computer, e ogni fatto mostra da dove proviene.",
      "settings.about.versionsHint": "Cosa è in esecuzione su questo computer.",
      "settings.computerUse.macPermissionsHint": "Cosa ha consentito il desktop.",
      "settings.connectorBundle.sandbox.none":
        "Questo computer non ha una sandbox per i connettori a comando, e Psyche non ne esegue mai uno al di fuori. Questo connettore non può essere installato qui. Non è stato avviato né salvato nulla.",
      "settings.connectorBundle.share.unavailable":
        "Solo Psyche sul computer che lo esegue può firmare un connettore.",
      "settings.deviceAccess.files.title": "File su questo computer",
      "settings.deviceAccess.terminal.hint":
        "{persona} può eseguire comandi di terminale su questo computer quando “Esegui comandi su questo computer” è attivo in Permessi → Accesso.",
      "settings.deviceAccess.terminal.where":
        "I comandi vengono eseguiti sul tuo computer, nelle cartelle che hai condiviso, e possono scrivere solo in una cartella condivisa in lettura e scrittura.",
      "settings.mcp.needs.title": "Cosa serve sul tuo computer",
      "settings.mcp.needs.node.fix":
        "Gira sul Node di Psyche; serve npm su questo computer. Installa Node.js da nodejs.org, oppure con il tuo gestore di pacchetti.",
      "settings.mcp.needs.uv.fix": "Un server Python. Installa uv da docs.astral.sh/uv.",
      "settings.mcp.fail.node_missing":
        "Installa Node.js (nodejs.org, oppure il tuo gestore di pacchetti) in modo che npm sia presente su questo computer, poi ricontrolla.",
      "settings.mcp.fail.uv_missing":
        "Installa uv (docs.astral.sh/uv), poi controlla di nuovo il server.",
      "settings.mail.voice.learn.hint":
        "Wren legge solo ciò che hai scritto nella posta inviata, senza testo citato né firme. Il profilo resta su questo computer in mail/VOICE.md.",
      "settings.mail.voice.localModel.hint":
        "Le bozze nel tuo stile non lasciano mai questo computer.",
      "settings.mail.transcribe.endpoint.hint":
        "Facoltativo. Un server compatibile con OpenAI per /v1/audio/transcriptions (ad esempio whisper.cpp su questo computer). Viene usato quando l’helper per Linux non ha un motore vocale. L’audio viene inviato solo a questo indirizzo: https, oppure http su 127.0.0.1.",
      "onboarding.mail.voiceHint":
        "Legge solo ciò che hai scritto, senza testo citato né firme. Resta su questo computer e puoi mostrarlo, modificarlo o ripristinarlo.",
      "gallery.preset.git.field.repo.help":
        "La cartella di un repository Git su questo computer. Psyche può leggerne cronologia e differenze.",
      "settings.connectors.page.onThisMac": "Su questo computer",
      "settings.connectors.page.row.local": "Gira su questo computer",
      "settings.connectors.page.server.local":
        "Uno strumento che gira in una sandbox su questo computer",
      "onboarding.permission.denied": "Disattivato nelle Impostazioni",
      "onboarding.permission.deniedHint":
        "Attivalo nelle Impostazioni di sistema; questa pagina si aggiorna quando torni.",
      "onboarding.permission.unavailableHint":
        "Psyche può chiederlo solo dall’app desktop di Psyche.",
      "onboarding.connectors.onThisMac": "Su questo computer",
      "onboarding.connectors.onThisMacHint":
        "Ogni app chiede il permesso al sistema mentre si collega, una alla volta.",
      "onboarding.model.kind.localHint": "Viene eseguito su questo computer; nulla lo lascia.",
      "onboarding.model.subscriptionNote":
        "Psyche usa l’app Claude Code o Codex a cui hai già eseguito l’accesso su questo computer, quindi non richiede né memorizza alcuna chiave API. Se non l’hai ancora fatto, accedi prima lì.",
      "onboarding.safety.touchId": "La tua password per le approvazioni",
      "onboarding.safety.touchId.checking": "Controllo dell’helper per Linux…",
      "onboarding.safety.touchId.setHint":
        "Le approvazioni che richiedono te chiedono la tua password.",
      "onboarding.safety.touchId.starting":
        "L’helper per Linux si sta ancora avviando. Ricontrolla tra un momento.",
      "onboarding.safety.touchId.noKey":
        "L’helper per Linux non ha una chiave di approvazione ({reason}).",
      "onboarding.safety.touchId.hint":
        "Registra una volta la chiave dell’helper per Linux, così la tua password potrà confermare le approvazioni.",
      "onboarding.safety.asks":
        "Se lasci che {name} esegua comandi su questo computer, quelli che si limitano a leggere, come ls o cat, vengono eseguiti senza scheda. Tutto il resto chiede prima a te.",
      "onboarding.done.touchId": "La tua password",
      "onboarding.done.try.search":
        "Fai una domanda in Cerca (Ctrl+K). La risposta mostra da quale parte della tua vita proviene.",
      "screens.search.source.revealFile": "Mostra in File",
      "everything.model.localHint":
        "Un modello su questo computer legge tutto. Nulla esce dal computer. Fatti meno numerosi e più confusi.",
      "everything.run.reason.battery":
        "Non ora: il computer è a batteria. Collegalo all’alimentazione o consenti l’esecuzione a batteria.",
      "everything.run.reason.thermal": "Non ora: il computer è troppo caldo.",
      "everything.run.reason.not_idle": "Non ora: stai usando il computer.",
      "everything.storage.note": "Tutto è memorizzato solo su questo computer.",
      "memoryWork.consent.k1":
        "Nulla esce da questo computer. Date e stato sono calcolati dal codice.",
      "screens.library.reveal": "Mostra in File",
      "web.zoom.description":
        "Quanto grande viene visualizzata l’app su questo computer. Ctrl+Più e Ctrl+Meno modificano la stessa impostazione, che sopravvive al riavvio; {min, number}–{max, number} %.",
      "web.transcriptMode.optionTitle": "{mode} (Ctrl+O per scorrere)",
      "web.backups.restore": "Ripristina su un nuovo computer con il Gateway arrestato:",
      "web.passkeys.firstApproval":
        "Approva “Aggiungi una passkey” con la tua password sul tuo computer o con una passkey su un altro dispositivo, poi premi di nuovo Aggiungi.",
      "web.passkeys.added":
        "{name} aggiunta. Ora approva le modifiche che richiedono la tua password o una passkey.",
      "web.remotePresence.title": "La tua password per le approvazioni",
      "web.remotePresence.description":
        "Acquisti, inserimento di credenziali, comandi sull’host e modifiche di sicurezza richiedono la tua password o una passkey. Configurala su questo computer per rispondere da qui; fino ad allora quelle schede dicono di rispondere su {host}. Le approvazioni normali non ne hanno mai bisogno.",
      "web.remotePresence.on": "Le approvazioni con password sono attive per questo computer.",
      "web.remotePresence.off":
        "Le approvazioni con password non sono configurate su questo computer.",
      "web.remotePresence.enable": "Usa la tua password per le approvazioni su questo computer",
      "web.remotePresence.waiting": "In attesa della tua password…",
      "web.remotePresence.passkeyName": "La tua password su questo computer",
      "web.remotePresence.enabled": "Le approvazioni con password sono attive per questo computer.",
      "web.remotePresence.disabled":
        "Le approvazioni con password sono disattivate su questo computer.",
      "web.remotePresence.approveOnHost":
        "Approva “Aggiungi una passkey” su {host}, con il suo Touch ID, Windows Hello o la sua password, oppure con una passkey, poi premi di nuovo il pulsante.",
      "web.remotePresence.unavailable":
        "Le approvazioni con password richiedono il Gateway di {host} a un indirizzo https:// (gateway.publicOrigin). Fino ad allora, rispondi a quelle schede su {host}.",
      "web.webauthn.noPasskeyYet":
        "Questo browser non ha ancora una passkey. Aggiungine una in Impostazioni → Dispositivi e nodi, oppure approva sul computer che esegue il Gateway.",
      "web.webauthn.needsOrigin":
        "Le passkey richiedono l’indirizzo https del server (gateway.publicOrigin). Approva invece sul computer che esegue il Gateway.",
      "web.setup.gatewayOk": "In esecuzione su questo computer.",
      "web.setup.adminOk": "Questo computer è il dispositivo amministratore.",
      "web.viewers.noSandbox":
        "Le anteprime delle diapositive richiedono la sandbox, e nessun runtime per container (Docker o Podman) è disponibile.",
      "web.voice.noEngine":
        "Nessun motore vocale disponibile. Installa un modello vocale in Impostazioni → Voce, oppure collega l’helper per Linux.",
      "web.threads.newSideChatTitle": "Nuova chat secondaria (Ctrl+N)",
      "web.panes.closePaneTitle": "Chiudi pannello (Ctrl+\\)",
      "web.chat.permissionModeTitle": "Modalità permessi (Ctrl+Shift+M)",
      "web.chat.modelTitle": "Modello (Ctrl+Shift+I)",
      "web.splash.installing": "Configurazione di Psyche su questo computer…",
      "web.splash.helper": "Preparazione di Psyche sul tuo computer…",
      "web.splash.remote.useThisMac": "Usa questo computer",
      "web.remote.thisMac": "Questo computer",
      "web.teach.bar.body":
        "Psyche annota i tuoi clic e ciò che digiti solo in questa scheda. Password, numeri di carta e codici non vengono mai registrati, e nulla lascia questo computer finché non salvi.",
      "settings.teach.storage.description":
        "Quando chiedi a Psyche di conservare una registrazione per poter creare un’altra versione, i passaggi vengono salvati su questo computer.",
      "settings.teach.storage.encrypted":
        "Cifrata. Il file è protetto da una chiave conservata nel portachiavi di sistema, quindi non si può leggere fuori da Psyche. Scade dopo 90 giorni.",
      "settings.teach.storage.unavailable":
        "Le registrazioni non vengono conservate. Il portachiavi di sistema non è disponibile e Psyche non salva una registrazione in chiaro. Puoi comunque salvare una registrazione come skill.",
      "web.teach.review.keepUnavailable":
        "Non disponibile: il portachiavi di sistema non è disponibile per cifrare una registrazione conservata.",
      "web.teach.review.keepRecording":
        "Conserva questa registrazione su questo computer così posso creare un’altra versione",
      "web.teach.app.recordHint":
        "Mostra a Psyche come fare qualcosa in un’app che hai già consentito",
      "web.teach.app.bar.body":
        "Psyche annota i tuoi clic, le scelte dai menu e ciò che digiti solo in {app}. I campi protetti non vengono mai registrati, non vengono fatti screenshot e nulla lascia questo computer finché non salvi. Anche l’area di notifica ha un pulsante Interrompi.",
      "voice.key.rightOption": "Alt destro",
      "voice.key.rightCommand": "Ctrl destro",
      "voice.settings.reviewHint":
        "Lascia ciò che Psyche ha sentito nel pop-up, così puoi correggerlo e premere Invio. Se è disattivato, viene inviato quando rilasci il tasto.",
      "meetingRecord.unavailable":
        "Per registrare serve un modo per trasformare l’audio in note (un modello vocale o l’helper per Linux), e nessuno è collegato.",
      "meetingRecord.micDenied":
        "Psyche non può usare il microfono. Consentilo nelle Impostazioni di sistema.",
      "platform.term.os": "Linux",
      "platform.term.device": "computer",
      "platform.term.thisDevice": "Questo computer",
      "platform.term.thisDeviceLower": "questo computer",
      "platform.term.presence": "la tua password",
      "platform.term.secretStore": "Portachiavi di sistema",
      "platform.term.systemSettings": "Impostazioni",
      "platform.term.fileManager": "File",
      "platform.term.trayArea": "area di notifica",
      "platform.term.taskbar": "barra delle applicazioni",
      "platform.term.systemSearch": "ricerca del desktop",
      "platform.term.helper": "helper per Linux",
      "platform.term.terminal": "Terminale",
      "platform.term.alt": "Alt",
      "platform.term.mod": "Ctrl",
      "web.security.banner.recovery":
        "{count, plural, one {Una modifica di sicurezza richiesta su questo computer si applica il {when}, a meno che tu non la annulli.} other {# modifiche di sicurezza richieste su questo computer sono in attesa. La prossima si applica il {when}.}}",
      "web.security.alert.changed":
        "Un programma su questo computer ha modificato {count, plural, one {1 dato di sicurezza} other {# dati di sicurezza}} senza passare da Psyche. Psyche {count, plural, one {l’ha ripristinato} other {li ha ripristinati}}. Se non sei stato tu, controlla il computer per software indesiderato.",
      "web.security.alert.untrusted":
        "Il controllo dei dati di sicurezza di Psyche non è riuscito. Nuovi dispositivi, impostazioni di sicurezza e approvazioni con password sono bloccati. Controlla i tuoi dispositivi, poi esegui psyched security reseal sul computer; si applica dopo 24 ore.",
      "web.security.alert.firstAdmin":
        "Un comando su questo computer ha reso {name} il primo dispositivo amministratore. Se non sei stato tu, revocalo in Dispositivi.",
      "web.security.alert.requested":
        "Richiesto su questo computer: {action} Si applica il {when}.",
      "web.security.op.presenceReset":
        "non chiedere più la tua password o una passkey per le modifiche di sicurezza finché non viene registrata una nuova chiave.",
      "web.security.needsApproval":
        "Approva la scheda con la tua password o una passkey, poi premi di nuovo il pulsante.",
    },
    ja: {
      "settings.devices.nodeKind.hostHelper": "Linux ヘルパー",
      "settings.links.description":
        "チャットのメッセージ、カード、アーティファクト内のリンクを開く場所です。Ctrl+クリックは常に既定のブラウザで開きます。",
      "errors.presence_required": "先にパスワードまたはパスキーで本人確認を行ってください。",
      "chat.toolbar.keySheet": "Ctrl+Shift+A",
      "chat.toolbar.keyModel": "Ctrl+Shift+I",
      "chat.toolbar.keyView": "Ctrl+O",
      "chat.approval.keysHint": "Ctrl+Enter {allows} · Ctrl+D {denies}",
      "blocks.details.runsOnHost": "このコンピュータ上、サンドボックスの外",
      "blocks.details.runsSandboxed":
        "コンピュータ上のサンドボックス内で実行: Psycheの保管庫、SSHキー、システムのキーリング、ブラウザのプロファイルは読み取れません",
      "blocks.details.runsNoSandbox":
        "コンピュータ上で実行されますが、サンドボックスが設定されていません（{reason}）",
      "blocks.permission.need.capability": "「このコンピュータでコマンドを実行」をオンにする",
      "blocks.permission.need.macos_access": "設定で{connector}にアクセスを許可",
      "blocks.permission.openSystemSettings": "設定を開く",
      "blocks.approval.answerOnHost":
        "{host}で回答するか、設定 → デバイスで、このコンピュータでの承認用にパスワードによる承認を設定してください。",
      "blocks.approval.needsAuth": "承認にはパスワードまたはパスキーが必要です。",
      "blocks.approval.touchIdFailed":
        "パスワードの確認に失敗しました: {reason}。もう一度お試しください。",
      "blocks.approval.touchIdFailedNoReason":
        "パスワードの確認に失敗しました。もう一度お試しください。",
      "blocks.approval.touchId.helperOffline":
        "Linuxヘルパーが動作していないため、ここでパスワードによる確認はできません。",
      "blocks.approval.touchId.noKey":
        "このコンピュータでは承認用のパスワード承認がまだ設定されていません。設定 → デバイスで設定してください。キーを先に確認できます。",
      "blocks.approval.touchId.invalidated":
        "このコンピュータのキーを設定した後でパスワードの設定が変更されたため、承認を確認できません。設定 → デバイスで設定し直してください。",
      "blocks.approval.touchId.noUnsandboxed":
        "サンドボックスなしでのコマンド実行は、このウインドウからパスワードで承認できません。代わりにサンドボックスを設定してください",
      "blocks.approval.touchId.onceOnly": "このウインドウからのパスワード承認は1回のみです。",
      "blocks.approval.status.allowedOnceTouchId":
        "1回のみ許可（このウインドウからのパスワード承認は1回のみ）",
      "blocks.approval.touchId.keyUnavailable":
        "このビルドのLinuxヘルパーは承認キーを保持できないため、このコンピュータではパスワードが必要なカードを承認できません。",
      "blocks.approval.touchId.cancelled":
        "パスワードの入力がキャンセルされたため、何も承認されていません",
      "shell.shortcut.pushToTalkKeys": "右Ctrlを長押し",
      "settings.shared.needsPresence":
        "「{label}」の変更にはパスワードまたはパスキーによる承認が必要です。設定またはPsycheの通知で承認してから、もう一度変更してください。",
      "settings.page.permissions.description":
        "{persona}がこのコンピュータで確認なしにできること、必ず確認を求める場面を設定します。",
      "settings.page.data.description":
        "このコンピュータに残るデータ、保存期間、書き出し、バックアップ、初期化を管理します。",
      "settings.essentials.model.noneHint":
        "{persona}が答えるにはモデルが必要です。キーを追加するか、このコンピュータのモデルを使ってください。",
      "settings.essentials.read.hint":
        "オンにするまではオフです。読み取った内容は、探し物をしやすくするためにこのコンピュータ上でインデックス化され、メモリの「情報源」でオプトアウトしない限り、メモリの学習にも使われます。",
      "settings.searchModel.apple.notOnThisMac": "macOSで利用できます",
      "settings.macHelper.paired.text":
        "このコンピュータでコンピュータ操作、画面コンテキスト、音声入力、パスワードによる承認、通知を担当します。",
      "settings.macHelper.unbundled.text":
        "このビルドのPsycheにはLinuxヘルパーが含まれていません。",
      "settings.key.appearance.showInDock": "ウインドウがないときもタスクバーに表示",
      "settings.semanticSearch.encrypt.pending":
        "Linuxヘルパーが暗号化インデックスを開くのを待っています",
      "settings.semanticSearch.rerankHint":
        "小型のクラウドモデルが最適な結果を上位に並べます。上位20件のスニペットがこのコンピュータの外に送信されます。初期値はオフです。",
      "settings.key.vm.enabled": "タスクにサンドボックスコンピュータを使用",
      "settings.key.vm.resetPerTask": "タスクごとに新しいコンピュータ",
      "settings.credentials.backend.psyche": "Psycheの保管庫（パスワード）",
      "settings.credentials.backend.keychain": "システムのキーリング",
      "settings.credentials.backendIn.keychain": "システムのキーリング内",
      "settings.credentials.err.lockedChange":
        "保管庫がロックされています。パスワードでロックを解除してから、もう一度{name}を{verb, select, delete {削除} other {変更}}してください。",
      "settings.credentials.err.lockedImport":
        "保管庫がロックされています。パスワードでロックを解除してから、もう一度読み込んでください。",
      "settings.credentials.slot.keychain": "システムのキーリング（パスワード）",
      "settings.credentials.slot.safeStorage": "このコンピュータのアプリストレージ",
      "settings.credentials.slot.keyFile": "このコンピュータ上のキーファイル",
      "settings.credentials.moveToKeychain": "システムのキーリングに移動",
      "settings.credentials.keyFileExplainer":
        "保管庫を開くキーは、あなたのアカウントだけが読めるファイルです。システムのキーリングに移動するにはLinuxヘルパーが必要ですが、このビルドのヘルパーは利用できません。",
      "settings.credentials.link.err.locked":
        "保管庫がロックされています。パスワードでロックを解除してから、もう一度{name}をリンクしてください。",
      "settings.approval.presenceUnavailable":
        "このウインドウでは本人確認ができません。コンピュータのPsycheアプリ（パスワード）か、パスキーのあるデバイスで変更を承認してください。それまで何も変更されません。",
      "settings.approval.promptDetail":
        "セキュリティ設定にはパスワードまたはパスキーが必要です。ここまたはPsycheの通知で承認すると、設定はすぐに保存されます。",
      "settings.approval.presenceInvalid":
        "パスワードまたはパスキーで本人確認ができませんでした。もう一度お試しください。",
      "settings.about.revealHome": "ファイルで表示",
      "settings.uninstall.keychainStays":
        "システムのキーリングの項目は残ります(保管庫のキーとHelperの項目)。必要ならキーリングのアプリで削除してください。",
      "settings.uninstall.keychainGoes": "保管庫とHelperのシステムのキーリング項目も削除されます。",
      "settings.uninstall.removeKeychain":
        "システムのキーリングの項目(Psycheのもの)も削除する。データがなければ使い道はありません。",
      "settings.uninstall.presence":
        "データが削除されるため、このあとパスワードまたはこのデバイスで確認が求められます。",
      "settings.appearance.showInDockHint":
        "オフの場合、最後のウインドウを閉じてもPsycheはシステムトレイで動き続けます。",
      "settings.appearance.openAtLoginHint":
        "サインイン時にシステムトレイでPsycheを起動し、スケジュール済みのオートメーションがいつでも実行できるようにします。",
      "settings.browser.letTasksUseHint":
        "各タスクはそれでも、このデバイスでパスワードまたはパスキーによる確認を先に求めます。",
      "settings.browser.detailsText":
        "タスクが使用している間、PsycheはこのプロファイルでGoogle Chromeを起動し、このコンピュータのループバック（127.0.0.1）でDevToolsポートを開き、タスクが終わると閉じます。あなた自身がプロファイルを開いている間、{persona}は接続されません。",
      "settings.browser.openFromMac":
        "Gatewayを実行しているコンピュータのPsycheアプリから開いてください。",
      "settings.channels.empty":
        "チャンネルはまだありません。TelegramまたはSlackを接続すると、このコンピュータから離れていても{persona}に連絡できます。",
      "settings.computerUse.description":
        "{persona}は、あなたが許可した範囲でのみこのコンピュータのアプリを使用できます。",
      "settings.computerUse.macPermissions": "デスクトップの権限",
      "settings.computerUse.openSystemSettingsFor": "{name}の設定を開く",
      "settings.computerUse.openSystemSettings": "設定を開く",
      "settings.trusted.loading": "このコンピュータから読み込んでいます…",
      "settings.trusted.noHelper":
        "コンピュータでPsycheを開くと一覧表示できます。ヘルパーが読み取ります。",
      "settings.trusted.failed": "Psycheはこのコンピュータから読み取れませんでした。",
      "settings.mcp.sandboxHelp":
        "コマンドサーバにはこのコンピュータ上のサンドボックスが必要です。",
      "settings.sandbox.why":
        "コマンドはあなたのファイルとともにコンピュータ上で実行されますが、保管庫、キー、Psycheの非公開データは読み取れません。",
      "settings.sandbox.whyHow":
        "Linux標準のサンドボックス機能（bubblewrap）上で、Anthropicのサンドボックスランタイムであるsrtを使います。仮想マシンは不要です。",
      "settings.sandbox.checking": "このコンピュータを確認しています…",
      "settings.sandbox.containers.body":
        "コンテナランタイムは、コンピュータのファイルにアクセスできない専用のLinuxマシンでコードを実行します。エージェントが実行するコードや一部のファイル変換に使われます。Gatewayがコンテナを使うよう設定されていない限り、コマンドサーバはsrtを使い続けます。",
      "settings.searchSources.description":
        "検索インデックスに取り込む内容です。オンにするまですべてオフで、インデックスはこのコンピュータ上に保持されます。情報源をオンにすると、メモリの「情報源」でオプトアウトしない限りメモリもそこから学習します（メモリと連絡先は例外で、どちらからも学習しません）。",
      "settings.searchSources.runOnBatteryHint":
        "コンピュータがバッテリー駆動中も、インデックス化、再構築、画像内のテキスト読み取りを控えめなペースで続けます。バッテリーの消費は増えます。省電力モード中は引き続き一時停止します。",
      "settings.searchSources.ocrHint":
        "スクリーンショットとスキャンしたPDFを1ページずつ読み取ります。電源接続時（または「バッテリー駆動中もインデックス化」がオンならバッテリー駆動中も）に実行します。コンピュータの外には何も送信されません。",
      "settings.semanticSearch.description":
        "言葉だけでなく意味でも探せます。すべてこのコンピュータ上で処理されます。",
      "settings.semanticSearch.engine.builtinHint":
        "Multilingual E5 small。約100言語に対応し、このコンピュータのプロセッサで動作します。",
      "settings.semanticSearch.engine.routerHint":
        "このコンピュータ上のOllamaやLM Studioなど、「ロール」で設定した埋め込みモデルを使います。",
      "settings.semanticSearch.allowCloudHint":
        "埋め込みモデルがクラウドサービスの場合のみ有効です。チャット、タスク、ライブラリのテキストが送信されます。オフにすると、すべてこのコンピュータ上に留まります。",
      "settings.semanticSearch.state.cloudBlocked":
        "「ロール」の埋め込みモデルはクラウドサービスです。セマンティック検索はこのコンピュータ上のモデルのみ使用します。",
      "settings.data.encryptMemory.pending": "Linuxヘルパーからのキーを待っています。",
      "settings.devices.touchId.none":
        "パスワードのキーはまだありません。登録するまで、パスワードが必要なカードは承認できません。",
      "settings.devices.touchId.noBundledKey":
        "このアプリのLinuxヘルパーには承認キーがありません（{reason}）。",
      "settings.devices.touchId.manualHint":
        "コンピュータでpsyche-helper --print-identityを実行し、表示されるpresenceKeyIdを貼り付けてください。",
      "settings.devices.noNodes":
        "ノードはありません。このコンピュータでPsycheが動作すると、Linuxヘルパーがここに表示されます。",
      "settings.files.execHost": "このコンピュータでコマンドを実行",
      "settings.files.execHostSwitch": "このコンピュータでのコマンドを許可",
      "settings.model.ram.tooSmall":
        "このコンピュータのメモリは{gb, number} GBです。ローカルモデルには{min, number} GB以上が必要です。代わりにクラウドプロバイダを使用してください。",
      "settings.model.ram.fits":
        "このコンピュータのメモリは{gb, number} GBなので、{fits}が動作します。",
      "settings.model.ram.thisMac": "（このコンピュータ）",
      "settings.model.localHint":
        "OllamaまたはLM Studioで、このコンピュータ上でモデルを実行します。",
      "settings.permissions.never.browserPasswords":
        "ブラウザやシステムのキーリングに保存されたパスワードを読み取る",
      "settings.server.bindHint":
        "127.0.0.1ならこのコンピュータ内に限定されます。すべてのインターフェイスにバインドする代わりに、下のリモートアクセスを使用してください。",
      "settings.gateways.description":
        "自宅のコンピュータなど、別のコンピュータのGatewayを使って、このコンピュータからPsycheを利用します。有効なGatewayは一度に1つで、切り替えるとPsycheが再起動します。",
      "settings.gateways.thisMac": "このコンピュータ",
      "settings.gateways.switchKeep":
        "Psycheは{name}で再起動します。このコンピュータ上のPsycheは動き続けるため、オートメーションも継続します。",
      "settings.gateways.switchAndStop": "切り替えて、このコンピュータ上のPsycheを停止",
      "settings.gateways.addHint":
        "Psycheを実行しているコンピュータのペアリングリンクを貼り付けてください（設定 → サーバとリモートアクセス → 別のコンピュータをペアリング）。リンクがない場合は、そのTailscaleアドレス（https://<host>.<tailnet>.ts.net）を入力します。このコンピュータがペアリングを要求し、所有者がそちらで承認します。",
      "settings.gateways.problem.link_malformed":
        "このペアリングリンクは破損しています。作成したコンピュータからもう一度コピーしてください。",
      "settings.gateways.problem.link_bad_field":
        "このペアリングリンクは破損しています。作成したコンピュータからもう一度コピーしてください。",
      "settings.gateways.problem.link_lan":
        "このペアリングリンクはローカルネットワーク上のコンピュータ用ですが、証明書が含まれていないため使用されません。そのコンピュータで「別のコンピュータをペアリング」→「このネットワークから」を選び、新しく作成してください。",
      "settings.remote.description":
        "ほかのコンピュータのPsycheが、Tailscale経由でこのコンピュータのGatewayを使えるようにします。Gatewayはこのコンピュータ上に留まり、Tailscaleのみを待ち受けます。入口はTailscale Serveだけです。",
      "settings.remote.step1":
        "このコンピュータとほかのコンピュータにTailscaleをインストールし、同じtailnetにサインインします。",
      "settings.remote.step2":
        "このコンピュータのターミナルで、Gatewayをtailnetに公開します。これはFunnelではなくServeです。",
      "settings.remote.step4":
        "Psycheを再起動します。次に、ほかのコンピュータでこのコンピュータをGatewayとして追加します。ペアリングコードとキーのフィンガープリントが表示されるので、ここの「ペアリング待ち」の要求と照合してから承認してください。",
      "settings.remote.admin":
        "ペアリングしたコンピュータには、読み取り、書き込み、承認の権限が付与されます。管理者権限は、承認時にチェックしない限りオフのままで、管理者としての変更には毎回ここでパスワードが必要です。",
      "settings.pair.needsAddress":
        "先にこのコンピュータの公開アドレス（上のステップ3）を設定してから、ペアリングリンクを作成してください。",
      "settings.pair.adminHint":
        "管理者権限があると、セキュリティ設定、デバイス、保管庫を変更できます。チェックしない限りオフです。管理者としての変更には毎回ここでパスワードが必要です。",
      "settings.pair.compare":
        "リンクを使う前に、そのコンピュータはこのコンピュータのキーを確認します: {fingerprint}。照合できます。",
      "settings.pair.secret":
        "今後10分間にこのリンクを持っている人は、誰でも1台のコンピュータをペアリングできます。投稿したり、このコンピュータを任せられない相手に送ったりしないでください。",
      "settings.pair.err.noAddress":
        "このコンピュータにはまだ公開アドレスがないため、リンクに含めるものがありません。",
      "settings.pair.viaAddress": "Tailscale経由で、このコンピュータのアドレスに",
      "settings.pair.viaLanHint":
        "このネットワーク用のリンクにはこのコンピュータのキーと証明書が含まれるため、同じWi-FiまたはEthernet上のコンピュータでのみ使えます。",
      "settings.pair.lanNote":
        "このリンクは、このコンピュータと同じネットワーク上のコンピュータ用です。Psycheが必ず確認するキーと証明書が指定されています。",
      "settings.lan.description":
        "同じWi-FiまたはEthernet上のほかのコンピュータのPsycheが、TailscaleなしでこのコンピュータのGatewayに接続できるようにします。オンにするまではオフです。",
      "settings.lan.toggleHint":
        "Psycheは1つのネットワークで、独自の証明書による暗号化接続で待ち受けます。接続してきたコンピュータは、ここでパスワードによる承認が必要です。",
      "settings.lan.noInterface":
        "このコンピュータにWi-FiまたはEthernet接続が見つかりませんでした。",
      "settings.lan.notAdvertised":
        "表示されていません。このコンピュータはアドレスで追加してください。",
      "settings.lan.problem.unknownInterface":
        "{name}はこのコンピュータにあるネットワークではありません。",
      "settings.lan.problem.advertise":
        "Psycheはネットワーク上で自身を通知できませんでした。コンピュータはこのコンピュータをアドレスで追加できます。",
      "settings.server.noVm":
        "VMはありません。VMモードはPsycheを別のゲストコンピュータ内で実行します。初期設定から設定してください。",
      "settings.shortcut.key.Control": "Ctrl",
      "settings.shortcut.key.Alt": "Alt",
      "settings.skills.permission.exec_host": "このコンピュータでコマンドを実行",
      "settings.skills.permission.computer_action": "このコンピュータのアプリを使用",
      "settings.skills.pathPlaceholder": "/home/you/Downloads/pdf-merge",
      "settings.skills.signer.originAgent":
        "送信者のコンピュータ上のアシスタントが作成しました。署名者に関わらず、未確認のテキストとして読んでください。",
      "settings.skills.export.hint":
        "ファイルはあなたの作成者キーで署名されるため、受け取った人はあなたのものであり改変されていないことを確認できます。キーはこのコンピュータ上に残ります。",
      "settings.vm.phase.installing": "ゲストをセットアップ中",
      "settings.vm.description":
        "別のサンドボックスコンピュータでタスクを実行し、{persona}があなたのLinuxではなく専用のコピーで作業するようにします。",
      "settings.vm.sandboxMac": "サンドボックスコンピュータ",
      "settings.vm.between": "あなたのコンピュータとゲストの間",
      "settings.vm.credentialsHint":
        "ホストの保管庫を使うと、値はコンピュータ上に残ります。ゲストの保管庫は独自のコピーを保持します。",
      "settings.vm.noReports":
        "報告したゲストはまだありません。このコンピュータのPsycheヘルパーから作成すると、その状態がここに表示されます。",
      "settings.voice.key.rightOption": "右Alt",
      "settings.voice.key.rightCommand": "右Ctrl",
      "settings.voice.reply.gatewayHint": "ペルソナに設定された声、またはシステムの声。",
      "settings.voice.engine.local": "このコンピュータ上",
      "settings.voice.engine.localHint":
        "Whisperがローカルで動作し、音声がコンピュータの外に出ることはありません。",
      "settings.voice.engine.system": "システムの音声入力",
      "settings.voice.engine.systemHint":
        "Linuxヘルパー経由で使う、システムのデバイス上の音声認識。",
      "settings.voice.model.usingHelper":
        "音声入力にはヘルパーの音声認識を使用します。音声モデルのほうが文字起こしの精度が高く、このコンピュータ上で動作します。",
      "settings.voice.model.downloadHint":
        "whisper.cppプロジェクトからの1回限りのダウンロードで、使用前に検証されます。音声がこのコンピュータの外に出ることはありません。",
      "settings.voice.model.ready": "このコンピュータ上のWhisper（{model}）",
      "settings.voice.model.readyHint":
        "音声入力と録音はここで文字起こしされ、音声がコンピュータの外に出ることはありません。",
      "settings.connect.finishOpened":
        "{name}へのサインインがGatewayのコンピュータのブラウザで開きました。完了すると、ここが更新されます。",
      "settings.connect.needsPermission":
        "{name}は設定されていますが、システムがまだ許可していません。次の場所で許可してください：",
      "settings.connect.openSystemSettings": "設定を開く",
      "settings.people.description":
        "{persona}があなたの生活の中の人物とプロジェクトについて保持するカードです。このコンピュータ上に留まり、すべての事実に出どころが表示されます。",
      "settings.about.versionsHint": "このコンピュータで動作しているもの。",
      "settings.computerUse.macPermissionsHint": "デスクトップが許可しているもの。",
      "settings.connectorBundle.sandbox.none":
        "このコンピュータにはコマンドコネクタ用のサンドボックスがなく、Psycheはサンドボックスの外では実行しません。このコネクタはここにインストールできません。何も起動も保存もされていません。",
      "settings.connectorBundle.share.unavailable":
        "コネクタに署名できるのは、それを実行しているコンピュータ上のPsycheだけです。",
      "settings.deviceAccess.files.title": "このコンピュータ上のファイル",
      "settings.deviceAccess.terminal.hint":
        "「権限 → アクセス」で「このコンピュータでコマンドを実行」がオンのとき、{persona}はこのコンピュータでターミナルコマンドを実行できます。",
      "settings.deviceAccess.terminal.where":
        "コマンドはコンピュータ上で、共有したフォルダ内で実行され、読み書きで共有したフォルダにのみ書き込めます。",
      "settings.mcp.needs.title": "このコンピュータで必要なもの",
      "settings.mcp.needs.node.fix":
        "Psyche独自のNodeで動作しますが、このコンピュータにnpmが必要です。nodejs.orgからNode.jsをインストールするか、パッケージマネージャを使ってインストールしてください。",
      "settings.mcp.needs.uv.fix":
        "Pythonサーバです。docs.astral.sh/uvからuvをインストールしてください。",
      "settings.mcp.fail.node_missing":
        "npmがこのコンピュータにあるよう、Node.js（nodejs.org、またはパッケージマネージャ）をインストールしてから、もう一度確認してください。",
      "settings.mcp.fail.uv_missing":
        "uv（docs.astral.sh/uv）をインストールしてから、もう一度サーバを確認してください。",
      "settings.mail.voice.learn.hint":
        "Wrenは送信済みメールのうち、引用部分や署名を除いたあなたの文章だけを読みます。プロファイルはこのコンピュータのmail/VOICE.mdに保存されます。",
      "settings.mail.voice.localModel.hint":
        "あなたの文体での下書きがこのコンピュータの外に出ることはありません。",
      "settings.mail.transcribe.endpoint.hint":
        "任意です。/v1/audio/transcriptions に対応した OpenAI 互換サーバー(例: このコンピュータ上の whisper.cpp)。Linux ヘルパーに音声認識エンジンがないときに使われます。音声はこのアドレスにのみ送信されます(https、または 127.0.0.1 の http)。",
      "onboarding.mail.voiceHint":
        "引用部分や署名を除き、あなたが書いた文章だけを読みます。内容はこのコンピュータに保存され、表示、編集、リセットができます。",
      "gallery.preset.git.field.repo.help":
        "このコンピュータ上のGitリポジトリのフォルダ。Psycheはその履歴と差分を読み取れます。",
      "settings.connectors.page.onThisMac": "このコンピュータ上",
      "settings.connectors.page.row.local": "このコンピュータ上で動作",
      "settings.connectors.page.server.local": "このコンピュータ上のサンドボックスで動作するツール",
      "onboarding.permission.denied": "設定でオフ",
      "onboarding.permission.deniedHint":
        "システムの設定でオンにしてください。戻ってくるとこのページが更新されます。",
      "onboarding.permission.unavailableHint":
        "Psycheがこれを求められるのは、Psycheデスクトップアプリ内だけです。",
      "onboarding.connectors.onThisMac": "このコンピュータ上",
      "onboarding.connectors.onThisMacHint":
        "各アプリは接続時に、1つずつシステムに許可を求めます。",
      "onboarding.model.kind.localHint": "このコンピュータ上で動作し、何も外に出ません。",
      "onboarding.model.subscriptionNote":
        "Psycheはこのコンピュータでサインイン済みのClaude CodeまたはCodexアプリを使用するため、APIキーは不要で、保存もしません。まだの場合は、先にそちらでサインインしてください。",
      "onboarding.safety.touchId": "承認にパスワードを使う",
      "onboarding.safety.touchId.checking": "Linuxヘルパーを確認しています…",
      "onboarding.safety.touchId.setHint": "あなたの対応が必要な承認では、パスワードを求めます。",
      "onboarding.safety.touchId.starting":
        "Linuxヘルパーはまだ起動中です。しばらくしてからもう一度確認してください。",
      "onboarding.safety.touchId.noKey": "Linuxヘルパーに承認キーがありません（{reason}）。",
      "onboarding.safety.touchId.hint":
        "Linuxヘルパーのキーを一度登録しておくと、パスワードで承認を確認できます。",
      "onboarding.safety.asks":
        "{name}にこのコンピュータでのコマンド実行を許可した場合、lsやcatのように読み取るだけのものはカードなしで実行されます。それ以外は先に確認します。",
      "onboarding.done.touchId": "パスワード",
      "onboarding.done.try.search":
        "検索（Ctrl+K）で質問してみましょう。回答には、生活のどこから得た情報かが表示されます。",
      "screens.search.source.revealFile": "ファイルで表示",
      "everything.model.localHint":
        "このコンピュータ上のモデルがすべてを読み取ります。コンピュータの外には何も出ません。事実は少なく、ノイズも増えます。",
      "everything.run.reason.battery":
        "今は実行できません: コンピュータがバッテリー駆動中です。電源に接続するか、バッテリー駆動での実行を許可してください。",
      "everything.run.reason.thermal": "今は実行できません: コンピュータの温度が高すぎます。",
      "everything.run.reason.not_idle": "今は実行できません: コンピュータを使用中です。",
      "everything.storage.note": "すべてこのコンピュータ上にのみ保存されます。",
      "memoryWork.consent.k1":
        "このコンピュータの外には何も出ません。日付とステータスはコードで算出されます。",
      "screens.library.reveal": "ファイルで表示",
      "web.zoom.description":
        "このコンピュータでのアプリの表示サイズ。Ctrl+プラスとCtrl+マイナスも同じ設定を変更するため、再起動後も保持されます。{min, number}〜{max, number}%。",
      "web.transcriptMode.optionTitle": "{mode}（Ctrl+Oで切り替え）",
      "web.backups.restore": "Gatewayを停止した状態で、新しいコンピュータに復元するには：",
      "web.passkeys.firstApproval":
        "コンピュータのパスワード、または別のデバイスのパスキーで「パスキーを追加」を承認してから、もう一度「追加」を押してください。",
      "web.passkeys.added":
        "{name}を追加しました。パスワードまたはパスキーが必要な変更をこれで承認できます。",
      "web.remotePresence.title": "承認にパスワードを使う",
      "web.remotePresence.description":
        "購入、認証情報の入力、ホストのコマンド、セキュリティの変更にはパスワードまたはパスキーが必要です。このコンピュータで設定すると、ここで回答できます。設定するまでは、これらのカードは{host}で回答するよう案内されます。通常の承認には必要ありません。",
      "web.remotePresence.on": "このコンピュータでパスワードによる承認がオンになっています。",
      "web.remotePresence.off": "このコンピュータではパスワードによる承認が設定されていません。",
      "web.remotePresence.enable": "このコンピュータの承認にパスワードを使う",
      "web.remotePresence.waiting": "パスワードを待っています…",
      "web.remotePresence.passkeyName": "このコンピュータのパスワード",
      "web.remotePresence.enabled": "このコンピュータでパスワードによる承認がオンになっています。",
      "web.remotePresence.disabled":
        "このコンピュータでは、パスワードによる承認がオフになっています。",
      "web.remotePresence.approveOnHost":
        "{host}でTouch ID、Windows Hello、パスワード、またはパスキーを使って「パスキーを追加」を承認してから、もう一度ボタンを押してください。",
      "web.remotePresence.unavailable":
        "パスワードによる承認には、{host}のGatewayがhttps://アドレス（gateway.publicOrigin）にある必要があります。それまでは、これらのカードを{host}で回答してください。",
      "web.webauthn.noPasskeyYet":
        "このブラウザにはまだパスキーがありません。設定 → デバイスとノードで追加するか、Gatewayを実行しているコンピュータで承認してください。",
      "web.webauthn.needsOrigin":
        "パスキーにはサーバのhttpsアドレス（gateway.publicOrigin）が必要です。代わりにGatewayを実行しているコンピュータで承認してください。",
      "web.setup.gatewayOk": "このコンピュータで動作中。",
      "web.setup.adminOk": "このコンピュータが管理者デバイスです。",
      "web.viewers.noSandbox":
        "スライドのプレビューにはサンドボックスが必要ですが、利用可能なコンテナランタイム（DockerまたはPodman）がありません。",
      "web.voice.noEngine":
        "利用可能な音声認識エンジンがありません。設定 → 音声で音声モデルをインストールするか、Linuxヘルパーを接続してください。",
      "web.threads.newSideChatTitle": "新しいサイドチャット（Ctrl+N）",
      "web.panes.closePaneTitle": "パネルを閉じる（Ctrl+\\）",
      "web.chat.permissionModeTitle": "権限モード（Ctrl+Shift+M）",
      "web.chat.modelTitle": "モデル（Ctrl+Shift+I）",
      "web.splash.installing": "このコンピュータにPsycheを設定中…",
      "web.splash.helper": "コンピュータでPsycheを準備中…",
      "web.splash.remote.useThisMac": "このコンピュータを使う",
      "web.remote.thisMac": "このコンピュータ",
      "web.teach.bar.body":
        "Psycheはこのタブでのクリックと入力のみを記録しています。パスワード、カード番号、コードは記録されず、保存するまでこのコンピュータの外には何も出ません。",
      "settings.teach.storage.description":
        "Psycheに別のバージョンを作れるよう録画を保存しておくよう頼むと、手順がこのコンピュータに保存されます。",
      "settings.teach.storage.encrypted":
        "暗号化済み。ファイルはシステムのキーリングに保管されたキーでロックされるため、Psyche以外では読み取れません。90日後に期限切れになります。",
      "settings.teach.storage.unavailable":
        "録画は保存されません。システムのキーリングを利用できず、Psycheは録画を平文で保存しないためです。録画をスキルとして保存することは引き続き可能です。",
      "web.teach.review.keepUnavailable":
        "利用できません: システムのキーリングを利用して、保存する録画を暗号化できません。",
      "web.teach.review.keepRecording":
        "別のバージョンを作れるよう、この録画をこのコンピュータに保存する",
      "web.teach.app.recordHint": "すでに許可したアプリでの操作をPsycheに見せます",
      "web.teach.app.bar.body":
        "Psycheは{app}でのクリック、メニューの選択、入力だけを記録します。保護されたフィールドは記録されず、スクリーンショットも撮られず、保存するまで何もこのコンピュータの外には出ません。システムトレイにも停止ボタンがあります。",
      "voice.key.rightOption": "右Alt",
      "voice.key.rightCommand": "右Ctrl",
      "voice.settings.reviewHint":
        "Psycheが聞き取った内容をポップアップに残すので、修正してからEnterキーで送信できます。オフの場合は、キーを離すと送信されます。",
      "meetingRecord.unavailable":
        "録音には、音声をノートに変換する手段（音声モデルまたはLinuxヘルパー）が必要ですが、どちらも接続されていません。",
      "meetingRecord.micDenied":
        "Psycheがマイクを使用できません。システムの設定で許可してください。",
      "platform.term.os": "Linux",
      "platform.term.device": "コンピュータ",
      "platform.term.thisDevice": "このコンピュータ",
      "platform.term.thisDeviceLower": "このコンピュータ",
      "platform.term.presence": "パスワード",
      "platform.term.secretStore": "システムのキーリング",
      "platform.term.systemSettings": "設定",
      "platform.term.fileManager": "ファイル",
      "platform.term.trayArea": "システムトレイ",
      "platform.term.taskbar": "タスクバー",
      "platform.term.systemSearch": "デスクトップ検索",
      "platform.term.helper": "Linuxヘルパー",
      "platform.term.terminal": "ターミナル",
      "platform.term.alt": "Alt",
      "platform.term.mod": "Ctrl",
      "web.security.banner.recovery":
        "{count, plural, other {このコンピュータで要求されたセキュリティ変更が # 件待機中です。次の変更はキャンセルしない限り {when} に適用されます。}}",
      "web.security.alert.changed":
        "このコンピュータ上のプログラムが Psyche を通さずにセキュリティ記録を {count, plural, other {# 件}}変更しました。Psyche は元に戻しました。心当たりがない場合は、コンピュータに不要なソフトウェアがないか確認してください。",
      "web.security.alert.untrusted":
        "Psyche のセキュリティ記録の確認に失敗しました。新しいデバイス、セキュリティ設定、パスワードによる承認はブロックされています。デバイスを確認してから、コンピュータで psyched security reseal を実行してください。24 時間後に適用されます。",
      "web.security.alert.firstAdmin":
        "このコンピュータのコマンドにより、{name} が最初の管理者デバイスになりました。心当たりがない場合は、デバイスで取り消してください。",
      "web.security.alert.requested": "このコンピュータで要求: {action} {when} に適用されます。",
      "web.security.op.presenceReset":
        "新しいキーが登録されるまで、セキュリティ変更にパスワードやパスキーを求めない。",
      "web.security.needsApproval":
        "パスワードまたはパスキーでカードを承認してから、もう一度ボタンを押してください。",
    },
    ko: {
      "settings.devices.nodeKind.hostHelper": "Linux 도우미",
      "settings.links.description":
        "채팅 메시지, 카드, 아티팩트의 링크가 열리는 곳입니다. Ctrl+클릭은 항상 기본 브라우저로 엽니다.",
      "errors.presence_required": "먼저 사용자 암호 또는 패스키로 본인임을 확인하십시오.",
      "chat.toolbar.keySheet": "Ctrl+Shift+A",
      "chat.toolbar.keyModel": "Ctrl+Shift+I",
      "chat.toolbar.keyView": "Ctrl+O",
      "chat.approval.keysHint": "Ctrl+Enter {allows} · Ctrl+D {denies}",
      "blocks.details.runsOnHost": "사용자의 컴퓨터, 샌드박스 외부",
      "blocks.details.runsSandboxed":
        "컴퓨터의 샌드박스 안에서 실행: Psyche 보관함, SSH 키, 시스템 키링, 브라우저 프로필을 읽을 수 없습니다",
      "blocks.details.runsNoSandbox":
        "컴퓨터에서 실행되지만 샌드박스가 설정되어 있지 않습니다 ({reason})",
      "blocks.permission.need.capability": '"이 컴퓨터에서 명령 실행" 켜기',
      "blocks.permission.need.macos_access": "설정에서 {connector}에 접근 허용",
      "blocks.permission.openSystemSettings": "설정 열기",
      "blocks.approval.answerOnHost":
        "{host}에서 답하거나 설정 → 기기에서 이 컴퓨터의 암호 승인을 설정하십시오.",
      "blocks.approval.needsAuth": "승인하려면 사용자 암호 또는 패스키가 필요합니다.",
      "blocks.approval.touchIdFailed": "암호 확인에 실패했습니다: {reason}. 다시 시도하십시오.",
      "blocks.approval.touchIdFailedNoReason": "암호 확인에 실패했습니다. 다시 시도하십시오.",
      "blocks.approval.touchId.helperOffline":
        "Linux 도우미가 실행 중이 아니어서 여기서 암호로 확인할 수 없습니다.",
      "blocks.approval.touchId.noKey":
        "이 컴퓨터에는 암호 승인이 아직 설정되어 있지 않습니다. 설정 → 기기에서 설정하십시오. 키를 먼저 확인할 수 있습니다.",
      "blocks.approval.touchId.invalidated":
        "이 컴퓨터의 키를 설정한 뒤 암호 설정이 변경되어 승인을 확인할 수 없습니다. 설정 → 기기에서 다시 설정하십시오.",
      "blocks.approval.touchId.noUnsandboxed":
        "샌드박스 없이 명령을 실행하는 것은 이 윈도우에서 암호로 승인할 수 없습니다. 대신 샌드박스를 설정하십시오",
      "blocks.approval.touchId.onceOnly": "이 윈도우에서의 암호 승인은 한 번만 가능합니다.",
      "blocks.approval.status.allowedOnceTouchId":
        "한 번만 허용 (이 윈도우에서의 암호 승인은 한 번만 가능)",
      "blocks.approval.touchId.keyUnavailable":
        "이 빌드의 Linux 도우미는 승인 키를 보관할 수 없어 이 컴퓨터에서는 암호가 필요한 카드를 승인할 수 없습니다.",
      "blocks.approval.touchId.cancelled": "암호 입력이 취소되어 아무것도 승인되지 않았습니다",
      "shell.shortcut.pushToTalkKeys": "오른쪽 Ctrl 길게 누르기",
      "settings.shared.needsPresence":
        "“{label}”을(를) 변경하려면 사용자 암호 또는 패스키로 승인해야 합니다. 설정이나 Psyche 알림에서 승인한 다음 다시 변경하십시오.",
      "settings.page.permissions.description":
        "{persona}가 이 컴퓨터에서 묻지 않고 할 수 있는 일과 항상 먼저 확인하는 경우를 설정합니다.",
      "settings.page.data.description":
        "이 컴퓨터에 남는 데이터, 보관 기간, 내보내기, 백업, 초기화를 관리합니다.",
      "settings.essentials.model.noneHint":
        "{persona}가 답하려면 모델이 필요합니다. 키를 추가하거나 이 컴퓨터의 모델을 사용하십시오.",
      "settings.essentials.read.hint":
        "켜기 전까지는 꺼져 있습니다. 읽은 내용은 찾기 쉽도록 이 컴퓨터에서 색인되며, 메모리 → 출처에서 제외하지 않으면 메모리 학습에도 사용됩니다.",
      "settings.searchModel.apple.notOnThisMac": "macOS에서 사용할 수 있음",
      "settings.macHelper.paired.text":
        "이 컴퓨터에서 컴퓨터 사용, 화면 컨텍스트, 받아쓰기, 암호 승인 및 알림을 담당합니다.",
      "settings.macHelper.unbundled.text": "이 빌드의 Psyche에는 Linux 도우미가 없습니다.",
      "settings.key.appearance.showInDock": "열린 윈도우가 없어도 작업 표시줄에 표시",
      "settings.semanticSearch.encrypt.pending":
        "Linux 도우미가 암호화된 색인을 열기를 기다리는 중",
      "settings.semanticSearch.rerankHint":
        "소형 클라우드 모델이 가장 알맞은 결과를 위로 올립니다. 상위 20개 스니펫이 이 컴퓨터 밖으로 전송됩니다. 기본값은 꺼짐입니다.",
      "settings.key.vm.enabled": "작업에 샌드박스 컴퓨터 사용",
      "settings.key.vm.resetPerTask": "작업마다 새 컴퓨터 사용",
      "settings.credentials.backend.psyche": "Psyche 금고 (사용자 암호)",
      "settings.credentials.backend.keychain": "시스템 키링",
      "settings.credentials.backendIn.keychain": "시스템 키링에 있음",
      "settings.credentials.err.lockedChange":
        "금고가 잠겨 있습니다. 사용자 암호로 잠금을 해제한 다음 {name}을(를) 다시 {verb, select, delete {삭제} other {변경}}하십시오.",
      "settings.credentials.err.lockedImport":
        "금고가 잠겨 있습니다. 사용자 암호로 잠금을 해제한 다음 다시 가져오십시오.",
      "settings.credentials.slot.keychain": "시스템 키링 (사용자 암호)",
      "settings.credentials.slot.safeStorage": "이 컴퓨터의 앱 저장 공간",
      "settings.credentials.slot.keyFile": "이 컴퓨터의 키 파일",
      "settings.credentials.moveToKeychain": "시스템 키링으로 이동",
      "settings.credentials.keyFileExplainer":
        "금고를 여는 키는 사용자 계정만 읽을 수 있는 파일입니다. 이를 시스템 키링으로 옮기려면 Linux 도우미가 필요한데, 이 빌드의 도우미는 사용할 수 없습니다.",
      "settings.credentials.link.err.locked":
        "금고가 잠겨 있습니다. 사용자 암호로 잠금을 해제한 다음 {name}을(를) 다시 연결하십시오.",
      "settings.approval.presenceUnavailable":
        "이 윈도우에서는 본인 확인을 할 수 없습니다. 컴퓨터의 Psyche 앱(사용자 암호) 또는 패스키가 있는 기기에서 변경을 승인하십시오. 그때까지는 아무것도 변경되지 않습니다.",
      "settings.approval.promptDetail":
        "보안 설정에는 사용자 암호 또는 패스키가 필요합니다. 여기서 또는 Psyche 알림에서 승인하십시오. 승인되는 즉시 설정이 저장됩니다.",
      "settings.approval.presenceInvalid":
        "사용자 암호 또는 패스키로 본인 확인이 되지 않았습니다. 다시 시도하십시오.",
      "settings.about.revealHome": "파일에서 보기",
      "settings.uninstall.keychainStays":
        "시스템 키링 항목은 그대로 남습니다(보관함 키와 도우미 항목). 원하시면 키링 앱에서 삭제하십시오.",
      "settings.uninstall.keychainGoes": "보관함과 도우미의 시스템 키링 항목도 함께 삭제됩니다.",
      "settings.uninstall.removeKeychain":
        "내 시스템 키링 항목(Psyche용 항목)도 삭제합니다. 데이터가 없으면 쓸모가 없습니다.",
      "settings.uninstall.presence":
        "데이터가 삭제되므로, 이어서 사용자 암호 또는 이 기기에서 확인하라는 요청이 표시됩니다.",
      "settings.appearance.showInDockHint":
        "끄면 마지막 윈도우를 닫아도 Psyche가 시스템 트레이에서 계속 실행됩니다.",
      "settings.appearance.openAtLoginHint":
        "로그인 시 시스템 트레이에서 Psyche를 시작해 예약된 자동화가 항상 실행될 수 있게 합니다.",
      "settings.browser.letTasksUseHint":
        "각 작업은 여전히 이 기기에서 사용자 암호 또는 패스키로 먼저 묻습니다.",
      "settings.browser.detailsText":
        "작업이 사용하는 동안 Psyche는 이 프로파일과 이 컴퓨터의 루프백(127.0.0.1) DevTools 포트로 Google Chrome을 실행하고, 작업이 끝나면 닫습니다. 사용자가 직접 프로파일을 열어 둔 동안에는 {persona}이(가) 연결되지 않습니다.",
      "settings.browser.openFromMac": "Gateway가 실행되는 컴퓨터의 Psyche 앱에서 여십시오.",
      "settings.channels.empty":
        "아직 채널이 없습니다. Telegram 또는 Slack을 연결하면 이 컴퓨터를 떠나서도 {persona}에게 연락할 수 있습니다.",
      "settings.computerUse.description":
        "{persona}은(는) 사용자가 허용한 범위에서만 이 컴퓨터의 앱을 사용할 수 있습니다.",
      "settings.computerUse.macPermissions": "데스크톱 권한",
      "settings.computerUse.openSystemSettingsFor": "{name}에 대한 설정 열기",
      "settings.computerUse.openSystemSettings": "설정 열기",
      "settings.trusted.loading": "이 컴퓨터에서 읽는 중…",
      "settings.trusted.noHelper":
        "컴퓨터에서 Psyche를 열면 목록을 볼 수 있습니다. 도우미가 읽어 옵니다.",
      "settings.trusted.failed": "Psyche가 이 컴퓨터에서 읽지 못했습니다.",
      "settings.mcp.sandboxHelp": "명령 서버에는 이 컴퓨터의 샌드박스가 필요합니다.",
      "settings.sandbox.why":
        "명령은 사용자의 파일과 함께 컴퓨터에서 실행되지만, 보관함, 키, Psyche의 비공개 데이터는 읽을 수 없습니다.",
      "settings.sandbox.whyHow":
        "Linux 자체 샌드박싱(bubblewrap)을 사용하여 Anthropic의 샌드박스 런타임인 srt를 사용합니다. 가상 머신은 필요하지 않습니다.",
      "settings.sandbox.checking": "이 컴퓨터를 확인하는 중…",
      "settings.sandbox.containers.body":
        "컨테이너 런타임은 컴퓨터의 파일에 접근할 수 없는 별도의 Linux 머신에서 코드를 실행합니다. 에이전트가 실행하는 코드와 일부 파일 변환에 사용됩니다. Gateway가 컨테이너를 사용하도록 설정되지 않으면 명령 서버는 계속 srt를 사용합니다.",
      "settings.searchSources.description":
        "검색 색인에 읽어 들이는 대상입니다. 켜기 전까지는 모두 꺼져 있으며, 색인은 이 컴퓨터에 보관됩니다. 출처를 켜면 메모리 → 출처에서 제외하지 않는 한 메모리도 이를 통해 학습합니다 (메모리와 연락처는 예외로, 둘 다 학습하지 않습니다).",
      "settings.searchSources.runOnBatteryHint":
        "컴퓨터가 배터리로 작동 중에도 색인, 다시 만들기, 이미지 속 텍스트 읽기를 느린 속도로 계속합니다. 배터리를 더 많이 사용합니다. 절전 모드에서는 계속 색인이 일시 중지됩니다.",
      "settings.searchSources.ocrHint":
        "스크린샷과 스캔한 PDF를 한 페이지씩 읽습니다. 전원 연결 시(또는 배터리 사용 중 색인이 켜져 있으면 배터리 사용 중에도) 실행됩니다. 이 컴퓨터 밖으로 아무것도 전송되지 않습니다.",
      "settings.semanticSearch.description":
        "단어뿐 아니라 의미로도 찾을 수 있습니다. 모든 처리는 이 컴퓨터에서 이루어집니다.",
      "settings.semanticSearch.engine.builtinHint":
        "Multilingual E5 small. 약 100개 언어를 지원하며 이 컴퓨터의 프로세서에서 실행됩니다.",
      "settings.semanticSearch.engine.routerHint":
        "이 컴퓨터의 Ollama나 LM Studio 등 역할에서 설정한 임베딩 모델을 사용합니다.",
      "settings.semanticSearch.allowCloudHint":
        "임베딩 모델이 클라우드 서비스일 때만 해당됩니다. 대화, 작업, 라이브러리 텍스트가 전송됩니다. 끄면 모든 것이 이 컴퓨터에 머뭅니다.",
      "settings.semanticSearch.state.cloudBlocked":
        "역할의 임베딩 모델이 클라우드 서비스입니다. 시맨틱 검색은 이 컴퓨터의 모델만 사용합니다.",
      "settings.data.encryptMemory.pending": "Linux 도우미의 키를 기다리는 중입니다.",
      "settings.devices.touchId.none":
        "암호 키가 아직 없습니다. 등록하기 전에는 사용자 암호가 필요한 카드를 승인할 수 없습니다.",
      "settings.devices.touchId.noBundledKey":
        "이 앱의 Linux 도우미에 승인 키가 없습니다 ({reason}).",
      "settings.devices.touchId.manualHint":
        "컴퓨터에서 psyche-helper --print-identity를 실행하고 출력되는 presenceKeyId를 붙여넣으십시오.",
      "settings.devices.noNodes":
        "노드가 없습니다. Psyche가 이 컴퓨터에서 실행되면 Linux 도우미가 여기에 나타납니다.",
      "settings.files.execHost": "이 컴퓨터에서 명령 실행",
      "settings.files.execHostSwitch": "이 컴퓨터에서 명령 허용",
      "settings.model.ram.tooSmall":
        "이 컴퓨터의 메모리는 {gb, number}GB입니다. 로컬 모델에는 최소 {min, number}GB가 필요하니 클라우드 제공업체를 사용하십시오.",
      "settings.model.ram.fits": "이 컴퓨터의 메모리는 {gb, number}GB입니다. 실행 가능: {fits}.",
      "settings.model.ram.thisMac": " (이 컴퓨터)",
      "settings.model.localHint": "Ollama 또는 LM Studio로 이 컴퓨터에서 모델을 실행합니다.",
      "settings.permissions.never.browserPasswords": "브라우저 또는 시스템 키링에 저장된 암호 읽기",
      "settings.server.bindHint":
        "127.0.0.1은 이 컴퓨터 안에만 유지합니다. 모든 인터페이스에 바인딩하는 대신 아래의 원격 접근을 사용하십시오.",
      "settings.gateways.description":
        "집에 있는 컴퓨터 등 다른 컴퓨터의 Gateway를 사용해 이 컴퓨터에서 Psyche를 이용합니다. 한 번에 하나의 Gateway만 활성화되며, 전환하면 Psyche가 다시 시작됩니다.",
      "settings.gateways.thisMac": "이 컴퓨터",
      "settings.gateways.switchKeep":
        "Psyche가 {name}에서 다시 시작됩니다. 이 컴퓨터의 Psyche는 계속 실행되므로 자동화도 계속됩니다.",
      "settings.gateways.switchAndStop": "전환하고 이 컴퓨터의 Psyche 중지",
      "settings.gateways.addHint":
        "Psyche를 실행하는 컴퓨터의 페어링 링크를 붙여넣으십시오 (설정 → 서버 및 원격 접근 → 다른 컴퓨터 페어링). 링크가 없으면 Tailscale 주소(https://<host>.<tailnet>.ts.net)를 입력하십시오. 그러면 이 컴퓨터가 페어링을 요청하고, 소유자가 그쪽에서 승인합니다.",
      "settings.gateways.problem.link_malformed":
        "이 페어링 링크가 손상되었습니다. 만든 컴퓨터에서 다시 복사하십시오.",
      "settings.gateways.problem.link_bad_field":
        "이 페어링 링크가 손상되었습니다. 만든 컴퓨터에서 다시 복사하십시오.",
      "settings.gateways.problem.link_lan":
        "이 페어링 링크는 로컬 네트워크의 컴퓨터용이지만 인증서가 없어 사용되지 않습니다. 해당 컴퓨터에서 다른 컴퓨터 페어링 → 이 네트워크에서를 선택해 새로 만드십시오.",
      "settings.remote.description":
        "다른 컴퓨터의 Psyche가 Tailscale을 통해 이 컴퓨터의 Gateway를 사용하도록 허용합니다. Gateway는 이 컴퓨터에 머물며 Tailscale만 수신하고, 유일한 진입 경로는 Tailscale Serve입니다.",
      "settings.remote.step1":
        "이 컴퓨터와 다른 컴퓨터에 Tailscale을 설치하고 같은 tailnet에 로그인하십시오.",
      "settings.remote.step2":
        "이 컴퓨터의 터미널에서 Gateway를 tailnet에 게시하십시오. Funnel이 아니라 Serve입니다.",
      "settings.remote.step4":
        "Psyche를 다시 시작합니다. 그런 다음 다른 컴퓨터에서 이 컴퓨터를 Gateway로 추가합니다. 페어링 코드와 키 지문이 표시되면, 여기 페어링 대기 중의 요청과 비교한 다음 승인하십시오.",
      "settings.remote.admin":
        "페어링된 컴퓨터에는 읽기, 쓰기, 승인 권한이 부여됩니다. 관리자 권한은 승인할 때 선택하지 않으면 꺼진 상태로 유지되며, 관리자 변경마다 여기서 사용자 암호가 필요합니다.",
      "settings.pair.needsAddress":
        "먼저 이 컴퓨터의 공개 주소(위 3단계)를 설정한 다음 페어링 링크를 만드십시오.",
      "settings.pair.adminHint":
        "관리자 권한이 있으면 보안 설정, 기기, 보관함을 변경할 수 있습니다. 선택하지 않으면 꺼져 있습니다. 관리자 변경마다 여기서 사용자 암호가 필요합니다.",
      "settings.pair.compare":
        "링크를 사용하기 전에 해당 컴퓨터가 이 컴퓨터의 키를 확인합니다: {fingerprint}. 비교해 보실 수 있습니다.",
      "settings.pair.secret":
        "앞으로 10분 동안 이 링크를 가진 사람은 누구든 컴퓨터 한 대를 페어링할 수 있습니다. 게시하거나, 이 컴퓨터를 맡길 수 없는 사람에게 보내지 마십시오.",
      "settings.pair.err.noAddress":
        "이 컴퓨터에는 아직 공개 주소가 없어 링크에 넣을 내용이 없습니다.",
      "settings.pair.viaAddress": "Tailscale을 통해 이 컴퓨터의 주소로",
      "settings.pair.viaLanHint":
        "이 네트워크용 링크에는 이 컴퓨터의 키와 인증서가 들어 있으므로 같은 Wi-Fi 또는 이더넷의 컴퓨터에서만 사용할 수 있습니다.",
      "settings.pair.lanNote":
        "이 링크는 이 컴퓨터와 같은 네트워크의 컴퓨터용입니다. Psyche가 반드시 확인할 키와 인증서가 지정되어 있습니다.",
      "settings.lan.description":
        "같은 Wi-Fi 또는 이더넷의 다른 컴퓨터에 있는 Psyche가 Tailscale 없이 이 컴퓨터의 Gateway에 연결할 수 있게 합니다. 켜기 전까지는 꺼져 있습니다.",
      "settings.lan.toggleHint":
        "Psyche는 하나의 네트워크에서 자체 인증서로 암호화된 연결을 통해 수신합니다. 연결하는 컴퓨터는 여기서 사용자 암호로 승인해야 합니다.",
      "settings.lan.noInterface": "이 컴퓨터에서 Wi-Fi 또는 이더넷 연결을 찾지 못했습니다.",
      "settings.lan.notAdvertised": "표시되지 않음. 이 컴퓨터는 주소로 추가하십시오.",
      "settings.lan.problem.unknownInterface": "{name}은(는) 이 컴퓨터에 있는 네트워크가 아닙니다.",
      "settings.lan.problem.advertise":
        "Psyche가 네트워크에서 자신을 알리지 못했습니다. 컴퓨터에서 이 컴퓨터를 주소로 추가할 수 있습니다.",
      "settings.server.noVm":
        "VM이 없습니다. VM 모드는 별도의 게스트 컴퓨터 안에서 Psyche를 실행합니다. 초기 설정에서 설정하십시오.",
      "settings.shortcut.key.Control": "Ctrl",
      "settings.shortcut.key.Alt": "Alt",
      "settings.skills.permission.exec_host": "이 컴퓨터에서 명령 실행",
      "settings.skills.permission.computer_action": "이 컴퓨터의 앱 사용",
      "settings.skills.pathPlaceholder": "/home/you/Downloads/pdf-merge",
      "settings.skills.signer.originAgent":
        "보낸 사람의 컴퓨터에서 어시스턴트가 작성했습니다. 서명한 사람과 관계없이 검토되지 않은 텍스트로 읽으십시오.",
      "settings.skills.export.hint":
        "파일은 사용자의 작성자 키로 서명되므로, 받는 사람은 사용자가 만든 것이며 변경되지 않았음을 확인할 수 있습니다. 키는 이 컴퓨터에 남습니다.",
      "settings.vm.phase.installing": "게스트 설정 중",
      "settings.vm.description":
        "별도의 샌드박스 컴퓨터에서 작업을 실행하여 {persona}이(가) 사용자의 Linux 대신 자체 Linux 사본에서 작업하게 합니다.",
      "settings.vm.sandboxMac": "샌드박스 컴퓨터",
      "settings.vm.between": "사용자의 컴퓨터와 게스트 사이",
      "settings.vm.credentialsHint":
        "호스트 보관함을 사용하면 값이 컴퓨터에 남습니다. 게스트 보관함은 자체 사본을 유지합니다.",
      "settings.vm.noReports":
        "아직 보고한 게스트가 없습니다. 이 컴퓨터의 Psyche 도우미에서 게스트를 생성하면 상태가 여기에 표시됩니다.",
      "settings.voice.key.rightOption": "오른쪽 Alt",
      "settings.voice.key.rightCommand": "오른쪽 Ctrl",
      "settings.voice.reply.gatewayHint": "페르소나에 설정된 목소리 또는 시스템 음성입니다.",
      "settings.voice.engine.local": "이 컴퓨터에서",
      "settings.voice.engine.localHint":
        "Whisper가 로컬에서 실행되며 오디오는 컴퓨터를 떠나지 않습니다.",
      "settings.voice.engine.system": "시스템 받아쓰기",
      "settings.voice.engine.systemHint": "Linux 도우미를 통한 시스템의 온디바이스 인식기입니다.",
      "settings.voice.model.usingHelper":
        "받아쓰기는 도우미의 음성 인식을 사용합니다. 음성 모델이 더 정확하게 받아쓰며 이 컴퓨터에서 실행됩니다.",
      "settings.voice.model.downloadHint":
        "whisper.cpp 프로젝트에서 한 번만 다운로드하며, 사용하기 전에 검증합니다. 오디오는 이 컴퓨터를 떠나지 않습니다.",
      "settings.voice.model.ready": "이 컴퓨터의 Whisper ({model})",
      "settings.voice.model.readyHint":
        "받아쓰기와 녹음은 여기서 텍스트로 변환됩니다. 오디오는 컴퓨터를 떠나지 않습니다.",
      "settings.connect.finishOpened":
        "Gateway가 실행되는 컴퓨터의 브라우저에서 {name} 로그인이 열렸습니다. 완료되면 여기가 업데이트됩니다.",
      "settings.connect.needsPermission":
        "{name}이(가) 설정되었지만 시스템이 아직 허용하지 않았습니다. 다음에서 허용하십시오:",
      "settings.connect.openSystemSettings": "설정 열기",
      "settings.people.description":
        "{persona}가 사용자 생활 속 사람과 프로젝트에 대해 보관하는 카드입니다. 이 컴퓨터에 머물며 모든 사실에 출처가 표시됩니다.",
      "settings.about.versionsHint": "이 컴퓨터에서 실행 중인 항목입니다.",
      "settings.computerUse.macPermissionsHint": "데스크톱이 허용한 항목입니다.",
      "settings.connectorBundle.sandbox.none":
        "이 컴퓨터에는 명령 커넥터용 샌드박스가 없으며, Psyche는 샌드박스 밖에서는 실행하지 않습니다. 이 커넥터는 여기에 설치할 수 없습니다. 아무것도 시작되거나 저장되지 않았습니다.",
      "settings.connectorBundle.share.unavailable":
        "커넥터에 서명할 수 있는 것은 그 커넥터를 실행하는 컴퓨터의 Psyche뿐입니다.",
      "settings.deviceAccess.files.title": "이 컴퓨터의 파일",
      "settings.deviceAccess.terminal.hint":
        "권한 → 접근에서 이 컴퓨터에서 명령 실행이 켜져 있으면 {persona}가 이 컴퓨터에서 터미널 명령을 실행할 수 있습니다.",
      "settings.deviceAccess.terminal.where":
        "명령은 컴퓨터에서 공유한 폴더 안에서 실행되며, 읽기 및 쓰기로 공유한 폴더에만 쓸 수 있습니다.",
      "settings.mcp.needs.title": "이 컴퓨터에서 필요한 것",
      "settings.mcp.needs.node.fix":
        "Psyche 자체 Node로 실행되지만 이 컴퓨터에 npm이 필요합니다. nodejs.org에서 Node.js를 설치하거나 패키지 관리자로 설치하십시오.",
      "settings.mcp.needs.uv.fix": "Python 서버입니다. docs.astral.sh/uv에서 uv를 설치하십시오.",
      "settings.mcp.fail.node_missing":
        "이 컴퓨터에 npm이 있도록 Node.js(nodejs.org 또는 패키지 관리자)를 설치한 다음 다시 확인하십시오.",
      "settings.mcp.fail.uv_missing":
        "uv(docs.astral.sh/uv)를 설치한 다음 서버를 다시 확인하십시오.",
      "settings.mail.voice.learn.hint":
        "Wren은 보낸 메일에서 인용문과 서명을 제외하고 직접 쓴 내용만 읽습니다. 프로필은 이 컴퓨터의 mail/VOICE.md에 저장됩니다.",
      "settings.mail.voice.localModel.hint": "내 문체로 쓴 초안은 이 컴퓨터를 벗어나지 않습니다.",
      "settings.mail.transcribe.endpoint.hint":
        "선택 사항입니다. /v1/audio/transcriptions를 지원하는 OpenAI 호환 서버(예: 이 컴퓨터의 whisper.cpp)입니다. Linux 도우미에 음성 인식 엔진이 없을 때 사용됩니다. 오디오는 이 주소로만 전송됩니다(https 또는 127.0.0.1의 http).",
      "onboarding.mail.voiceHint":
        "인용문과 서명을 제외하고 직접 쓴 내용만 읽습니다. 이 컴퓨터에만 저장되며 보기, 편집, 초기화할 수 있습니다.",
      "gallery.preset.git.field.repo.help":
        "이 컴퓨터의 Git 저장소 폴더입니다. Psyche가 기록과 차이를 읽을 수 있습니다.",
      "settings.connectors.page.onThisMac": "이 컴퓨터",
      "settings.connectors.page.row.local": "이 컴퓨터에서 실행",
      "settings.connectors.page.server.local": "이 컴퓨터의 샌드박스에서 실행되는 도구",
      "onboarding.permission.denied": "설정에서 꺼져 있음",
      "onboarding.permission.deniedHint":
        "시스템 설정에서 켜십시오. 돌아오면 이 페이지가 업데이트됩니다.",
      "onboarding.permission.unavailableHint":
        "Psyche는 Psyche 데스크톱 앱에서만 이 권한을 요청할 수 있습니다.",
      "onboarding.connectors.onThisMac": "이 컴퓨터",
      "onboarding.connectors.onThisMacHint": "각 앱은 연결될 때 하나씩 시스템에 권한을 요청합니다.",
      "onboarding.model.kind.localHint": "이 컴퓨터에서 실행되며 아무것도 밖으로 나가지 않습니다.",
      "onboarding.model.subscriptionNote":
        "Psyche는 이 컴퓨터에 이미 로그인된 Claude Code 또는 Codex 앱을 사용하므로 API 키가 필요 없고 저장하지도 않습니다. 아직 로그인하지 않았다면 먼저 그곳에서 로그인하십시오.",
      "onboarding.safety.touchId": "승인에 사용자 암호 사용",
      "onboarding.safety.touchId.checking": "Linux 도우미를 확인하는 중…",
      "onboarding.safety.touchId.setHint":
        "사용자의 확인이 필요한 승인에서는 사용자 암호를 요청합니다.",
      "onboarding.safety.touchId.starting":
        "Linux 도우미가 아직 시작 중입니다. 잠시 후 다시 확인하십시오.",
      "onboarding.safety.touchId.noKey": "Linux 도우미에 승인 키가 없습니다 ({reason}).",
      "onboarding.safety.touchId.hint":
        "Linux 도우미의 키를 한 번 등록하면 사용자 암호로 승인을 확인할 수 있습니다.",
      "onboarding.safety.asks":
        "{name}이(가) 이 컴퓨터에서 명령을 실행하도록 허용하면 ls나 cat처럼 읽기만 하는 명령은 카드 없이 실행됩니다. 그 밖의 명령은 먼저 확인합니다.",
      "onboarding.done.touchId": "사용자 암호",
      "onboarding.done.try.search":
        "검색(Ctrl+K)에서 질문해 보십시오. 답변에는 생활 속 어디에서 온 정보인지 표시됩니다.",
      "screens.search.source.revealFile": "파일에서 보기",
      "everything.model.localHint":
        "이 컴퓨터의 모델이 모든 것을 읽습니다. 이 컴퓨터 밖으로 아무것도 나가지 않습니다. 사실은 더 적고 잡음은 더 많아집니다.",
      "everything.run.reason.battery":
        "지금은 실행할 수 없습니다: 컴퓨터가 배터리를 사용 중입니다. 전원에 연결하거나 배터리 사용 중 실행을 허용하십시오.",
      "everything.run.reason.thermal": "지금은 실행할 수 없습니다: 컴퓨터의 온도가 너무 높습니다.",
      "everything.run.reason.not_idle": "지금은 실행할 수 없습니다: 컴퓨터를 사용 중입니다.",
      "everything.storage.note": "모든 내용은 이 컴퓨터에만 저장됩니다.",
      "memoryWork.consent.k1":
        "이 컴퓨터 밖으로 아무것도 나가지 않습니다. 날짜와 상태는 코드로 계산됩니다.",
      "screens.library.reveal": "파일에서 보기",
      "web.zoom.description":
        "이 컴퓨터에서 앱이 표시되는 크기입니다. Ctrl+Plus와 Ctrl+Minus도 같은 설정을 변경하므로 재시동 후에도 유지됩니다. {min, number}–{max, number}%.",
      "web.transcriptMode.optionTitle": "{mode} (Ctrl+O로 전환)",
      "web.backups.restore": "Gateway를 중지한 상태에서 새 컴퓨터에 복원하려면:",
      "web.passkeys.firstApproval":
        "컴퓨터의 사용자 암호 또는 다른 기기의 패스키로 “패스키 추가”를 승인한 다음 추가를 다시 누르십시오.",
      "web.passkeys.added":
        "{name}을(를) 추가했습니다. 이제 사용자 암호 또는 패스키가 필요한 변경을 승인합니다.",
      "web.remotePresence.title": "승인에 사용자 암호 사용",
      "web.remotePresence.description":
        "구매, 자격 증명 입력, 호스트 명령, 보안 변경에는 사용자 암호 또는 패스키가 필요합니다. 이 컴퓨터에서 설정하면 여기서 응답할 수 있습니다. 설정하기 전까지는 해당 카드에서 {host}에서 응답하도록 안내합니다. 일반 승인에는 필요하지 않습니다.",
      "web.remotePresence.on": "이 컴퓨터에서 암호 승인이 켜져 있습니다.",
      "web.remotePresence.off": "이 컴퓨터에는 암호 승인이 설정되어 있지 않습니다.",
      "web.remotePresence.enable": "이 컴퓨터의 승인에 사용자 암호 사용",
      "web.remotePresence.waiting": "사용자 암호를 기다리는 중…",
      "web.remotePresence.passkeyName": "이 컴퓨터의 사용자 암호",
      "web.remotePresence.enabled": "이 컴퓨터에서 암호 승인이 켜져 있습니다.",
      "web.remotePresence.disabled": "이 컴퓨터에서는 암호 승인이 꺼져 있습니다.",
      "web.remotePresence.approveOnHost":
        '{host}에서 해당 컴퓨터의 Touch ID, Windows Hello 또는 암호, 혹은 패스키로 "패스키 추가"를 승인한 다음 버튼을 다시 누르십시오.',
      "web.remotePresence.unavailable":
        "암호 승인을 사용하려면 {host}의 Gateway가 https:// 주소(gateway.publicOrigin)에 있어야 합니다. 그때까지는 해당 카드를 {host}에서 응답하십시오.",
      "web.webauthn.noPasskeyYet":
        "이 브라우저에는 아직 패스키가 없습니다. 설정 → 기기 및 노드에서 추가하거나 Gateway를 실행하는 컴퓨터에서 승인하십시오.",
      "web.webauthn.needsOrigin":
        "패스키에는 서버의 https 주소(gateway.publicOrigin)가 필요합니다. 대신 Gateway를 실행하는 컴퓨터에서 승인하십시오.",
      "web.setup.gatewayOk": "이 컴퓨터에서 실행 중입니다.",
      "web.setup.adminOk": "이 컴퓨터가 관리자 기기입니다.",
      "web.viewers.noSandbox":
        "슬라이드 미리보기에는 샌드박스가 필요한데, 사용 가능한 컨테이너 런타임(Docker 또는 Podman)이 없습니다.",
      "web.voice.noEngine":
        "사용 가능한 음성 인식 엔진이 없습니다. 설정 → 음성에서 음성 모델을 설치하거나 Linux 도우미를 연결하십시오.",
      "web.threads.newSideChatTitle": "새 사이드 채팅 (Ctrl+N)",
      "web.panes.closePaneTitle": "패널 닫기 (Ctrl+\\)",
      "web.chat.permissionModeTitle": "권한 모드 (Ctrl+Shift+M)",
      "web.chat.modelTitle": "모델 (Ctrl+Shift+I)",
      "web.splash.installing": "이 컴퓨터에 Psyche를 설정하는 중…",
      "web.splash.helper": "컴퓨터에서 Psyche를 준비하는 중…",
      "web.splash.remote.useThisMac": "이 컴퓨터 사용",
      "web.remote.thisMac": "이 컴퓨터",
      "web.teach.bar.body":
        "Psyche가 이 탭에서의 클릭과 입력만 기록하고 있습니다. 암호, 카드 번호, 코드는 기록되지 않으며 저장하기 전까지 이 컴퓨터 밖으로 아무것도 나가지 않습니다.",
      "settings.teach.storage.description":
        "다른 버전을 만들 수 있도록 Psyche에 녹화를 보관하라고 요청하면 단계가 이 컴퓨터에 저장됩니다.",
      "settings.teach.storage.encrypted":
        "암호화됨. 파일은 시스템 키링에 보관된 키로 잠겨 있어 Psyche 밖에서는 읽을 수 없습니다. 90일 후 만료됩니다.",
      "settings.teach.storage.unavailable":
        "녹화가 보관되지 않습니다. 시스템 키링을 사용할 수 없고, Psyche는 녹화를 일반 텍스트로 저장하지 않기 때문입니다. 녹화를 스킬로 저장하는 것은 여전히 가능합니다.",
      "web.teach.review.keepUnavailable":
        "사용할 수 없음: 보관할 녹화를 암호화하는 데 쓸 시스템 키링을 사용할 수 없습니다.",
      "web.teach.review.keepRecording": "다른 버전을 만들 수 있도록 이 녹화를 이 컴퓨터에 보관",
      "web.teach.app.recordHint": "이미 허용한 앱에서 작업하는 방법을 Psyche에 보여 줍니다",
      "web.teach.app.bar.body":
        "Psyche는 {app}에서의 클릭, 메뉴 선택, 입력만 기록합니다. 보안 입력란은 녹화되지 않고, 스크린샷도 찍지 않으며, 저장하기 전에는 아무것도 이 컴퓨터를 벗어나지 않습니다. 시스템 트레이에도 중지 버튼이 있습니다.",
      "voice.key.rightOption": "오른쪽 Alt",
      "voice.key.rightCommand": "오른쪽 Ctrl",
      "voice.settings.reviewHint":
        "Psyche가 들은 내용을 팝업에 남겨 두므로 고친 다음 Enter 키를 누를 수 있습니다. 끄면 키를 놓을 때 전송됩니다.",
      "meetingRecord.unavailable":
        "녹음하려면 오디오를 노트로 변환하는 수단(음성 모델 또는 Linux 도우미)이 필요한데 연결된 것이 없습니다.",
      "meetingRecord.micDenied": "Psyche가 마이크를 사용할 수 없습니다. 설정에서 허용하십시오.",
      "platform.term.os": "Linux",
      "platform.term.device": "컴퓨터",
      "platform.term.thisDevice": "이 컴퓨터",
      "platform.term.thisDeviceLower": "이 컴퓨터",
      "platform.term.presence": "사용자 암호",
      "platform.term.secretStore": "시스템 키링",
      "platform.term.systemSettings": "설정",
      "platform.term.fileManager": "파일",
      "platform.term.trayArea": "시스템 트레이",
      "platform.term.taskbar": "작업 표시줄",
      "platform.term.systemSearch": "데스크톱 검색",
      "platform.term.helper": "Linux 도우미",
      "platform.term.terminal": "터미널",
      "platform.term.alt": "Alt",
      "platform.term.mod": "Ctrl",
      "web.security.banner.recovery":
        "{count, plural, other {이 컴퓨터에서 요청된 보안 변경 #건이 대기 중입니다. 다음 변경은 취소하지 않으면 {when}에 적용됩니다.}}",
      "web.security.alert.changed":
        "이 컴퓨터의 프로그램이 Psyche를 거치지 않고 보안 기록 {count}건을 변경했습니다. Psyche가 원래대로 되돌렸습니다. 본인이 한 일이 아니라면 컴퓨터에 원치 않는 소프트웨어가 있는지 확인하세요.",
      "web.security.alert.untrusted":
        "Psyche 보안 기록 확인에 실패했습니다. 새 기기, 보안 설정, 암호 승인이 차단됩니다. 기기를 확인한 다음 컴퓨터에서 psyched security reseal을 실행하세요. 24시간 후에 적용됩니다.",
      "web.security.alert.firstAdmin":
        "이 컴퓨터의 명령으로 {name}이(가) 첫 관리자 기기가 되었습니다. 본인이 한 일이 아니라면 기기에서 취소하세요.",
      "web.security.alert.requested": "이 컴퓨터에서 요청됨: {action} {when}에 적용됩니다.",
      "web.security.op.presenceReset":
        "새 키가 등록될 때까지 보안 변경에 사용자 암호나 패스키를 요구하지 않음.",
      "web.security.needsApproval":
        "사용자 암호나 패스키로 카드를 승인한 다음 버튼을 다시 누르세요.",
    },
    pt: {
      "settings.devices.nodeKind.hostHelper": "Assistente do Linux",
      "settings.links.description":
        "Onde abre um link de uma mensagem, cartão ou artefato. Ctrl+clique sempre usa o navegador padrão.",
      "errors.presence_required":
        "Confirme que é você com a sua senha ou uma chave-senha primeiro.",
      "chat.toolbar.keySheet": "Ctrl+Shift+A",
      "chat.toolbar.keyModel": "Ctrl+Shift+I",
      "chat.toolbar.keyView": "Ctrl+O",
      "chat.approval.keysHint": "Ctrl+Enter {allows} · Ctrl+D {denies}",
      "blocks.details.runsOnHost": "no seu computador, fora da sandbox",
      "blocks.details.runsSandboxed":
        "no seu computador, na sandbox: não pode ler o cofre do Psyche, suas chaves SSH, o chaveiro do sistema nem perfis de navegador",
      "blocks.details.runsNoSandbox":
        "no seu computador, e a sandbox não está configurada ({reason})",
      "blocks.permission.need.capability": "Ative “Executar comandos neste computador”",
      "blocks.permission.need.macos_access": "Dê acesso a {connector} nas Configurações",
      "blocks.permission.openSystemSettings": "Abrir Configurações",
      "blocks.approval.answerOnHost":
        "Responda em {host}, ou configure aprovações por senha para este computador em Configurações → Dispositivos.",
      "blocks.approval.needsAuth": "Precisa da sua senha ou de uma chave-senha para aprovar.",
      "blocks.approval.touchIdFailed": "A verificação da senha falhou: {reason}. Tente novamente.",
      "blocks.approval.touchIdFailedNoReason": "A verificação da senha falhou. Tente novamente.",
      "blocks.approval.touchId.helperOffline":
        "O assistente do Linux não está em execução, então a sua senha não pode confirmar aqui.",
      "blocks.approval.touchId.noKey":
        "As aprovações por senha ainda não estão configuradas neste computador. Configure em Configurações → Dispositivos, onde você pode verificar a chave antes.",
      "blocks.approval.touchId.invalidated":
        "A configuração da sua senha mudou desde que a chave deste computador foi configurada, então não pode confirmar aprovações. Configure novamente em Configurações → Dispositivos.",
      "blocks.approval.touchId.noUnsandboxed":
        "Executar um comando sem a sandbox não pode ser aprovado com a sua senha desta janela. Configure a sandbox no lugar",
      "blocks.approval.touchId.onceOnly": "As aprovações por senha desta janela valem só uma vez.",
      "blocks.approval.status.allowedOnceTouchId":
        "Permitido uma vez (as aprovações por senha desta janela valem só uma vez)",
      "blocks.approval.touchId.keyUnavailable":
        "Esta versão do assistente do Linux não consegue guardar uma chave de aprovação, então os cartões que exigem a sua senha não podem ser aprovados neste computador.",
      "blocks.approval.touchId.cancelled":
        "O pedido de senha foi cancelado, então nada foi aprovado",
      "shell.shortcut.pushToTalkKeys": "Segure Ctrl direito",
      "settings.shared.needsPresence":
        "Alterar “{label}” precisa da sua aprovação com a sua senha ou uma chave-senha. Aprove nas Configurações ou na notificação do Psyche e depois altere novamente.",
      "settings.page.permissions.description":
        "O que {persona} pode fazer neste computador sem perguntar, e onde sempre para para perguntar a você.",
      "settings.page.data.description":
        "O que fica neste computador, por quanto tempo é guardado, exportações, backups e recomeçar do zero.",
      "settings.essentials.model.noneHint":
        "{persona} precisa de um modelo para poder responder. Adicione uma chave ou use um modelo neste computador.",
      "settings.essentials.read.hint":
        "Desativado até você ativar algum. O que é lido é indexado neste computador para encontrar coisas para você, e a memória também aprende com isso, a menos que você desative em Memória → Fontes.",
      "settings.searchModel.apple.notOnThisMac": "Disponível no macOS",
      "settings.macHelper.paired.text":
        "Executa o uso do computador, o contexto da tela, o ditado, as aprovações por senha e as notificações neste computador.",
      "settings.macHelper.unbundled.text": "Esta versão do Psyche não tem o assistente do Linux.",
      "settings.key.appearance.showInDock":
        "Mostrar na barra de tarefas quando não há janelas abertas",
      "settings.semanticSearch.encrypt.pending":
        "Aguardando o assistente do Linux abrir o índice criptografado",
      "settings.semanticSearch.rerankHint":
        "Um modelo pequeno na nuvem coloca os melhores resultados primeiro. Os 20 trechos principais saem deste computador. Desativado por padrão.",
      "settings.key.vm.enabled": "Usar um computador em sandbox para tarefas",
      "settings.key.vm.resetPerTask": "Computador novo para cada tarefa",
      "settings.credentials.backend.psyche": "Cofre do Psyche (sua senha)",
      "settings.credentials.backend.keychain": "Chaveiro do sistema",
      "settings.credentials.backendIn.keychain": "no chaveiro do sistema",
      "settings.credentials.err.lockedChange":
        "O cofre está bloqueado. Desbloqueie com a sua senha e depois {verb, select, delete {apague} other {altere}} {name} novamente.",
      "settings.credentials.err.lockedImport":
        "O cofre está bloqueado. Desbloqueie com a sua senha e depois importe novamente.",
      "settings.credentials.slot.keychain": "o chaveiro do sistema (sua senha)",
      "settings.credentials.slot.safeStorage": "o armazenamento de apps deste computador",
      "settings.credentials.slot.keyFile": "um arquivo de chave neste computador",
      "settings.credentials.moveToKeychain": "Mover para o chaveiro do sistema",
      "settings.credentials.keyFileExplainer":
        "A chave que abre seu cofre é um arquivo que só a sua conta pode ler. Movê-la para o chaveiro do sistema precisa do assistente do Linux; o assistente desta versão não está disponível.",
      "settings.credentials.link.err.locked":
        "O cofre está bloqueado. Desbloqueie com a sua senha e depois vincule {name} novamente.",
      "settings.approval.presenceUnavailable":
        "Esta janela não consegue confirmar que é você. Aprove a mudança no app Psyche do seu computador (sua senha) ou de um dispositivo com chave-senha. Nada muda até lá.",
      "settings.approval.promptDetail":
        "Configurações de segurança precisam da sua senha ou de uma chave-senha. Aprove aqui ou na notificação do Psyche; a configuração é salva assim que for aprovada.",
      "settings.approval.presenceInvalid":
        "A sua senha ou a chave-senha não confirmou que é você. Tente novamente.",
      "settings.about.revealHome": "Mostrar em Arquivos",
      "settings.uninstall.keychainStays":
        "Os itens do chaveiro do sistema ficam (a chave do cofre e os do assistente). Remova-os no app do seu chaveiro se quiser.",
      "settings.uninstall.keychainGoes":
        "Os itens do chaveiro do sistema do cofre e do assistente também são removidos.",
      "settings.uninstall.removeKeychain":
        "Remover também meus itens do chaveiro do sistema (os do Psyche). Sem seus dados, eles não servem para nada.",
      "settings.uninstall.presence":
        "Depois você será solicitado a confirmar com a sua senha ou neste dispositivo, porque isso remove seus dados.",
      "settings.appearance.showInDockHint":
        "Desativado, o Psyche continua em execução na bandeja do sistema quando a última janela é fechada.",
      "settings.appearance.openAtLoginHint":
        "Inicia o Psyche na bandeja do sistema quando você entra, para que as automações agendadas sempre possam ser executadas.",
      "settings.browser.letTasksUseHint":
        "Cada tarefa ainda pergunta a você primeiro, neste dispositivo, com a sua senha ou uma chave-senha.",
      "settings.browser.detailsText":
        "Enquanto uma tarefa o usa, o Psyche executa o Google Chrome com este perfil e uma porta DevTools no loopback deste computador (127.0.0.1), e o fecha quando a tarefa termina. {persona} não fica conectado enquanto você mesmo estiver com o perfil aberto.",
      "settings.browser.openFromMac": "Abra-o pelo app Psyche no computador que executa o Gateway.",
      "settings.channels.empty":
        "Nenhum canal ainda. Conecte o Telegram ou o Slack para falar com {persona} longe deste computador.",
      "settings.computerUse.description":
        "{persona} pode usar apps neste computador somente onde você permitir.",
      "settings.computerUse.macPermissions": "Permissões da área de trabalho",
      "settings.computerUse.openSystemSettingsFor": "Abrir Configurações para {name}",
      "settings.computerUse.openSystemSettings": "Abrir Configurações",
      "settings.trusted.loading": "Lendo-os deste computador…",
      "settings.trusted.noHelper": "Abra o Psyche no seu computador para vê-los: o auxiliar os lê.",
      "settings.trusted.failed": "O Psyche não conseguiu lê-los neste computador.",
      "settings.mcp.sandboxHelp": "Servidores de comando precisam de uma sandbox neste computador.",
      "settings.sandbox.why":
        "Os comandos rodam no seu computador com seus arquivos, mas não podem ler seu cofre, suas chaves nem os dados privados do Psyche.",
      "settings.sandbox.whyHow":
        "Usa o srt, o runtime de sandbox da Anthropic, com a própria sandbox do Linux (bubblewrap). Não precisa de máquina virtual.",
      "settings.sandbox.checking": "Examinando este computador…",
      "settings.sandbox.containers.body":
        "Um runtime de contêineres executa o código em sua própria máquina Linux, sem acesso aos arquivos do seu computador: para o código que o agente executa e algumas conversões de arquivos. Os servidores de comando continuam usando o srt, a menos que o Gateway esteja configurado para usar contêineres.",
      "settings.searchSources.description":
        "O que o Psyche lê para o seu índice de pesquisa. Tudo fica desativado até você ativar; o índice permanece neste computador. Ativar uma fonte também deixa a memória aprender com ela, a menos que você desative em Memória → Fontes (Memória e Contatos são exceções: não se aprende com nenhuma das duas).",
      "settings.searchSources.runOnBatteryHint":
        "Permite que a indexação, Reconstruir e a leitura de texto em imagens continuem enquanto o computador está na bateria, em ritmo mais suave. Gasta mais bateria. A economia de energia ainda pausa a indexação.",
      "settings.searchSources.ocrHint":
        "Lê capturas de tela e PDFs digitalizados, uma página por vez, na tomada (ou na bateria com “Indexar na bateria” ativado). Nada sai do seu computador.",
      "settings.semanticSearch.description":
        "Encontre coisas pelo significado além das palavras, tudo neste computador.",
      "settings.semanticSearch.engine.builtinHint":
        "Multilingual E5 small, cerca de 100 idiomas, roda no processador deste computador.",
      "settings.semanticSearch.engine.routerHint":
        "Usa o modelo de embeddings definido em Funções, por exemplo Ollama ou LM Studio neste computador.",
      "settings.semanticSearch.allowCloudHint":
        "Só se o modelo de embeddings for um serviço na nuvem. Seus chats, tarefas e o texto da Biblioteca são enviados a ele. Desativado mantém tudo neste computador.",
      "settings.semanticSearch.state.cloudBlocked":
        "O modelo de embeddings em Funções é um serviço na nuvem. A pesquisa semântica só usa modelos deste computador.",
      "settings.data.encryptMemory.pending": "Aguardando a chave do assistente do Linux.",
      "settings.devices.touchId.none":
        "Ainda não há chave de senha. Cartões que exigem a sua senha não podem ser aprovados até uma ser registrada.",
      "settings.devices.touchId.noBundledKey":
        "O assistente do Linux deste app não tem chave de aprovação ({reason}).",
      "settings.devices.touchId.manualHint":
        "Execute psyche-helper --print-identity no computador e cole o presenceKeyId que ele imprime.",
      "settings.devices.noNodes":
        "Nenhum nó. O assistente do Linux aparece aqui quando o Psyche é executado neste computador.",
      "settings.files.execHost": "Executar comandos neste computador",
      "settings.files.execHostSwitch": "Permitir comandos neste computador",
      "settings.model.ram.tooSmall":
        "Este computador tem {gb, number} GB. Modelos locais precisam de pelo menos {min, number} GB; use um provedor na nuvem.",
      "settings.model.ram.fits": "Este computador tem {gb, number} GB, então {fits} cabem.",
      "settings.model.ram.thisMac": " (este computador)",
      "settings.model.localHint": "Execute modelos neste computador com o Ollama ou o LM Studio.",
      "settings.permissions.never.browserPasswords":
        "Ler senhas salvas nos seus navegadores ou no chaveiro do sistema",
      "settings.server.bindHint":
        "127.0.0.1 o mantém neste computador. Use o acesso remoto abaixo em vez de vincular a todas as interfaces.",
      "settings.gateways.description":
        "Use o Psyche neste computador com o Gateway de outro, como o seu computador de casa. Só um Gateway fica ativo por vez, e trocar reinicia o Psyche.",
      "settings.gateways.thisMac": "Este computador",
      "settings.gateways.switchKeep":
        "O Psyche reinicia em {name}. O Psyche neste computador continua em execução, então as automações dele continuam.",
      "settings.gateways.switchAndStop": "Trocar e parar o Psyche neste computador",
      "settings.gateways.addHint":
        "Cole o link de emparelhamento do computador que executa o Psyche (Configurações, Servidor e acesso remoto, Emparelhar outro computador). Sem link, digite o endereço do Tailscale dele, https://<host>.<tailnet>.ts.net; este computador então pede para emparelhar, e o proprietário aprova lá.",
      "settings.gateways.problem.link_malformed":
        "Esse link de emparelhamento está danificado. Copie-o de novo do computador que o criou.",
      "settings.gateways.problem.link_bad_field":
        "Esse link de emparelhamento está danificado. Copie-o de novo do computador que o criou.",
      "settings.gateways.problem.link_lan":
        "Este link de emparelhamento é de um computador da sua rede local, mas não traz o certificado dele, então não é usado. Nesse computador, crie um novo: Emparelhar outro computador, Desta rede.",
      "settings.remote.description":
        "Deixe o Psyche em outro computador usar o Gateway deste computador por meio do Tailscale. O Gateway fica neste computador e só escuta o Tailscale; o Tailscale Serve é a única entrada.",
      "settings.remote.step1":
        "Instale o Tailscale neste computador e no outro computador, e entre nos dois na mesma tailnet.",
      "settings.remote.step2":
        "Em um terminal neste computador, publique o Gateway na sua tailnet. É Serve, não Funnel.",
      "settings.remote.step4":
        "Reinicie o Psyche. Depois, no outro computador, adicione este computador como Gateway. Ele mostra um código de emparelhamento e a impressão digital de uma chave: compare-os com o pedido em “Aguardando emparelhamento” aqui e aprove.",
      "settings.remote.admin":
        "Um computador que emparelha recebe leitura, gravação e aprovações. Admin continua desativado, a menos que você marque ao aprovar, e cada alteração de admin ainda exige a sua senha aqui.",
      "settings.pair.needsAddress":
        "Defina primeiro o endereço público deste computador (etapa 3 acima) e depois crie um link de emparelhamento.",
      "settings.pair.adminHint":
        "Admin permite alterar configurações de segurança, dispositivos e o cofre, e continua desativado, a menos que você marque. Cada alteração de admin ainda exige a sua senha aqui.",
      "settings.pair.compare":
        "Ele verifica a chave deste computador antes de usar o link: {fingerprint}. Você pode comparar.",
      "settings.pair.secret":
        "Quem tiver este link nos próximos dez minutos pode emparelhar um computador. Não o publique nem o envie a ninguém em quem você não confiaria para este computador.",
      "settings.pair.err.noAddress":
        "Este computador ainda não tem endereço público, então não há nada para colocar em um link.",
      "settings.pair.viaAddress": "Pelo Tailscale, no endereço deste computador",
      "settings.pair.viaLanHint":
        "Um link para esta rede contém a chave e o certificado deste computador, então só funciona para computadores no mesmo Wi-Fi ou Ethernet.",
      "settings.pair.lanNote":
        "Este link é para computadores na mesma rede que este computador. Ele indica a chave e o certificado que o Psyche vai exigir.",
      "settings.lan.description":
        "Deixe o Psyche em outro computador no mesmo Wi-Fi ou Ethernet acessar o Gateway deste computador, sem Tailscale. Fica desativado até você ativar.",
      "settings.lan.toggleHint":
        "O Psyche escuta em uma rede, por uma conexão criptografada com seu próprio certificado. Um computador que se conecta ainda precisa ser aprovado aqui com a sua senha.",
      "settings.lan.noInterface":
        "Nenhuma conexão Wi-Fi ou Ethernet foi encontrada neste computador.",
      "settings.lan.notAdvertised": "Não visível. Adicione este computador pelo endereço.",
      "settings.lan.problem.unknownInterface": "{name} não é uma rede deste computador.",
      "settings.lan.problem.advertise":
        "O Psyche não conseguiu se anunciar na rede. Os computadores ainda podem adicionar este computador pelo endereço.",
      "settings.server.noVm":
        "Nenhuma VM. O modo VM executa o Psyche dentro de um computador convidado separado; configure-o pela introdução.",
      "settings.shortcut.key.Control": "Ctrl",
      "settings.shortcut.key.Alt": "Alt",
      "settings.skills.permission.exec_host": "Executar comandos neste computador",
      "settings.skills.permission.computer_action": "Usar apps neste computador",
      "settings.skills.pathPlaceholder": "/home/voce/Downloads/pdf-merge",
      "settings.skills.signer.originAgent":
        "Escrito por um assistente no computador do remetente. Leia como texto não revisado, seja quem for que assinou.",
      "settings.skills.export.hint":
        "O arquivo é assinado com a sua chave de autor, para que quem o receba saiba que é seu e que não foi alterado. A chave fica neste computador.",
      "settings.vm.phase.installing": "Configurando o convidado",
      "settings.vm.description":
        "Execute tarefas em um computador em sandbox separado, para que {persona} trabalhe na própria cópia do Linux em vez da sua.",
      "settings.vm.sandboxMac": "Computador em sandbox",
      "settings.vm.between": "Entre o seu computador e o convidado",
      "settings.vm.credentialsHint":
        "Com o cofre do anfitrião, os valores ficam no seu computador. Um cofre do convidado guarda a própria cópia.",
      "settings.vm.noReports":
        "Nenhum convidado se reportou ainda. Crie um pelo assistente do Psyche neste computador; o estado dele aparece aqui.",
      "settings.voice.key.rightOption": "Alt direito",
      "settings.voice.key.rightCommand": "Ctrl direito",
      "settings.voice.reply.gatewayHint": "A voz definida para a persona ou a voz do sistema.",
      "settings.voice.engine.local": "Neste computador",
      "settings.voice.engine.localHint":
        "O Whisper é executado localmente; o áudio nunca sai do computador.",
      "settings.voice.engine.system": "Ditado do sistema",
      "settings.voice.engine.systemHint":
        "O reconhecedor do sistema no dispositivo, por meio do assistente do Linux.",
      "settings.voice.model.usingHelper":
        "O ditado usa o reconhecimento de fala do assistente. O modelo de fala transcreve melhor e roda neste computador.",
      "settings.voice.model.downloadHint":
        "Um download único do projeto whisper.cpp, verificado antes de ser usado. O áudio nunca sai deste computador.",
      "settings.voice.model.ready": "Whisper ({model}) neste computador",
      "settings.voice.model.readyHint":
        "O ditado e as gravações são transcritos aqui; o áudio nunca sai do computador.",
      "settings.connect.finishOpened":
        "O login em {name} foi aberto no navegador do computador do Gateway. Isto é atualizado quando você terminar.",
      "settings.connect.needsPermission":
        "{name} está configurado, mas o sistema ainda não o permitiu. Permita em",
      "settings.connect.openSystemSettings": "Abrir Configurações",
      "settings.people.description":
        "Os cartões que {persona} guarda sobre as pessoas e projetos da sua vida. Ficam neste computador e cada fato mostra de onde veio.",
      "settings.about.versionsHint": "O que está rodando neste computador.",
      "settings.computerUse.macPermissionsHint": "O que a área de trabalho permite.",
      "settings.connectorBundle.sandbox.none":
        "Este computador não tem sandbox para conectores de comando, e o Psyche nunca executa um fora dela. Este conector não pode ser instalado aqui. Nada foi iniciado nem salvo.",
      "settings.connectorBundle.share.unavailable":
        "Só o Psyche no computador que o executa pode assinar um conector.",
      "settings.deviceAccess.files.title": "Arquivos neste computador",
      "settings.deviceAccess.terminal.hint":
        "{persona} pode executar comandos de terminal neste computador quando “Executar comandos neste computador” está ativado em Permissões → Acesso.",
      "settings.deviceAccess.terminal.where":
        "Os comandos rodam no seu computador, nas pastas que você compartilhou, e só podem gravar em uma pasta compartilhada com leitura e gravação.",
      "settings.mcp.needs.title": "O que isto precisa no seu computador",
      "settings.mcp.needs.node.fix":
        "Roda no Node próprio do Psyche; precisa do npm neste computador. Instale o Node.js em nodejs.org ou pelo seu gerenciador de pacotes.",
      "settings.mcp.needs.uv.fix": "Um servidor Python. Instale o uv em docs.astral.sh/uv.",
      "settings.mcp.fail.node_missing":
        "Instale o Node.js (nodejs.org, ou o seu gerenciador de pacotes) para que o npm esteja neste computador e verifique novamente.",
      "settings.mcp.fail.uv_missing":
        "Instale o uv (docs.astral.sh/uv) e verifique o servidor novamente.",
      "settings.mail.voice.learn.hint":
        "A Wren lê apenas o que você escreveu nos e-mails enviados, sem texto citado nem assinaturas. O perfil fica neste computador, em mail/VOICE.md.",
      "settings.mail.voice.localModel.hint": "Rascunhos no seu estilo nunca saem deste computador.",
      "settings.mail.transcribe.endpoint.hint":
        "Opcional. Um servidor compatível com OpenAI para /v1/audio/transcriptions (por exemplo, whisper.cpp neste computador). Usado quando o assistente do Linux não tem um motor de fala. O áudio só é enviado para este endereço: https, ou http em 127.0.0.1.",
      "onboarding.mail.voiceHint":
        "Lê apenas o que você escreveu, sem texto citado nem assinaturas. Fica neste computador e você pode ver, editar ou redefinir.",
      "gallery.preset.git.field.repo.help":
        "A pasta de um repositório Git neste computador. O Psyche pode ler o histórico e os diffs dele.",
      "settings.connectors.page.onThisMac": "Neste computador",
      "settings.connectors.page.row.local": "Roda neste computador",
      "settings.connectors.page.server.local":
        "Uma ferramenta que roda em uma sandbox neste computador",
      "onboarding.permission.denied": "Desativada nas Configurações",
      "onboarding.permission.deniedHint":
        "Ative nas Configurações do seu sistema; esta página é atualizada quando você voltar.",
      "onboarding.permission.unavailableHint":
        "O Psyche só pode pedir isto no app de desktop do Psyche.",
      "onboarding.connectors.onThisMac": "Neste computador",
      "onboarding.connectors.onThisMacHint":
        "Cada app pede permissão ao sistema ao conectar, uma de cada vez.",
      "onboarding.model.kind.localHint": "Roda neste computador; nada sai dele.",
      "onboarding.model.subscriptionNote":
        "O Psyche usa o app Claude Code ou Codex já conectado neste computador, então não precisa de chave de API e não guarda nenhuma. Faça login lá primeiro, se ainda não fez.",
      "onboarding.safety.touchId": "Sua senha para aprovações",
      "onboarding.safety.touchId.checking": "Examinando o assistente do Linux…",
      "onboarding.safety.touchId.setHint": "Aprovações que precisam de você pedem sua senha.",
      "onboarding.safety.touchId.starting":
        "O assistente do Linux ainda está iniciando. Verifique novamente em instantes.",
      "onboarding.safety.touchId.noKey":
        "O assistente do Linux não tem chave de aprovação ({reason}).",
      "onboarding.safety.touchId.hint":
        "Registre uma vez a chave do assistente do Linux para que a sua senha possa confirmar aprovações.",
      "onboarding.safety.asks":
        "Se você deixar {name} executar comandos neste computador, os que só leem, como ls ou cat, rodam sem cartão. Todo o resto pergunta antes.",
      "onboarding.done.touchId": "Sua senha",
      "onboarding.done.try.search":
        "Faça uma pergunta em Pesquisar (Ctrl+K). A resposta mostra de onde na sua vida ela veio.",
      "screens.search.source.revealFile": "Mostrar em Arquivos",
      "everything.model.localHint":
        "Um modelo neste computador lê tudo. Nada sai do computador. Menos fatos e mais ruído.",
      "everything.run.reason.battery":
        "Agora não: o computador está na bateria. Conecte-o ou permita execuções na bateria.",
      "everything.run.reason.thermal": "Agora não: o computador está quente demais.",
      "everything.run.reason.not_idle": "Agora não: você está usando o computador.",
      "everything.storage.note": "Tudo é armazenado só neste computador.",
      "memoryWork.consent.k1":
        "Nada sai deste computador. Datas e status são calculados por código.",
      "screens.library.reveal": "Mostrar em Arquivos",
      "web.zoom.description":
        "O tamanho em que o app é exibido neste computador. Ctrl+Mais e Ctrl+Menos alteram o mesmo ajuste, então ele é mantido após reiniciar; {min, number}–{max, number} %.",
      "web.transcriptMode.optionTitle": "{mode} (Ctrl+O alterna)",
      "web.backups.restore": "Restaure em um novo computador com o Gateway parado:",
      "web.passkeys.firstApproval":
        "Aprove “Adicionar uma chave-senha” com a sua senha no seu computador ou com uma chave-senha em outro dispositivo, depois pressione Adicionar novamente.",
      "web.passkeys.added":
        "{name} foi adicionada. Agora ela aprova alterações que precisam da sua senha ou de uma chave-senha.",
      "web.remotePresence.title": "Sua senha para aprovações",
      "web.remotePresence.description":
        "Compras, preenchimento de credenciais, comandos do host e alterações de segurança exigem a sua senha ou uma chave-senha. Configure-a neste computador para respondê-los aqui; até lá esses cartões dizem para responder em {host}. Aprovações comuns nunca precisam dela.",
      "web.remotePresence.on": "As aprovações por senha estão ativadas para este computador.",
      "web.remotePresence.off": "As aprovações por senha não estão configuradas neste computador.",
      "web.remotePresence.enable": "Usar a sua senha para aprovações neste computador",
      "web.remotePresence.waiting": "Aguardando a sua senha…",
      "web.remotePresence.passkeyName": "Sua senha neste computador",
      "web.remotePresence.enabled": "As aprovações por senha estão ativadas para este computador.",
      "web.remotePresence.disabled": "As aprovações por senha estão desativadas neste computador.",
      "web.remotePresence.approveOnHost":
        "Aprove “Adicionar uma chave-senha” em {host}, com o Touch ID, o Windows Hello ou a senha dele, ou com uma chave-senha, e clique no botão novamente.",
      "web.remotePresence.unavailable":
        "As aprovações por senha precisam do Gateway de {host} em um endereço https:// (gateway.publicOrigin). Até lá, responda esses cartões em {host}.",
      "web.webauthn.noPasskeyYet":
        "Este navegador ainda não tem chave-senha. Adicione uma em Configurações → Dispositivos ou aprove no computador que executa o Gateway.",
      "web.webauthn.needsOrigin":
        "As chaves-senha precisam do endereço https do servidor (gateway.publicOrigin). Aprove no computador que executa o Gateway.",
      "web.setup.gatewayOk": "Em execução neste computador.",
      "web.setup.adminOk": "Este computador é o dispositivo administrador.",
      "web.viewers.noSandbox":
        "As pré-visualizações de slides precisam da sandbox, e nenhum ambiente de contêineres (Docker ou Podman) está disponível.",
      "web.voice.noEngine":
        "Nenhum motor de fala está disponível. Instale um modelo de fala em Configurações → Voz ou conecte o assistente do Linux.",
      "web.threads.newSideChatTitle": "Nova conversa paralela (Ctrl+N)",
      "web.panes.closePaneTitle": "Fechar painel (Ctrl+\\)",
      "web.chat.permissionModeTitle": "Modo de permissão (Ctrl+Shift+M)",
      "web.chat.modelTitle": "Modelo (Ctrl+Shift+I)",
      "web.splash.installing": "Configurando o Psyche neste computador…",
      "web.splash.helper": "Preparando o Psyche no seu computador…",
      "web.splash.remote.useThisMac": "Usar este computador",
      "web.remote.thisMac": "Este computador",
      "web.teach.bar.body":
        "O Psyche anota seus cliques e o que você digita só nesta aba. Senhas, números de cartão e códigos nunca são gravados, e nada sai deste computador até você salvar.",
      "settings.teach.storage.description":
        "Quando você pede ao Psyche para guardar uma gravação para poder fazer outra versão, as etapas são salvas neste computador.",
      "settings.teach.storage.encrypted":
        "Criptografada. O arquivo é protegido com uma chave guardada no chaveiro do sistema, então não pode ser lido fora do Psyche. Expira em 90 dias.",
      "settings.teach.storage.unavailable":
        "As gravações não são guardadas. O chaveiro do sistema não está disponível e o Psyche não salvará uma gravação como texto simples. Você ainda pode salvar uma gravação como habilidade.",
      "web.teach.review.keepUnavailable":
        "Indisponível: o chaveiro do sistema não está disponível para criptografar uma gravação guardada.",
      "web.teach.review.keepRecording":
        "Guardar esta gravação neste computador para eu poder fazer outra versão",
      "web.teach.app.recordHint":
        "Mostrar ao Psyche como fazer algo em um app que você já permitiu",
      "web.teach.app.bar.body":
        "O Psyche anota seus cliques, escolhas de menu e digitação apenas em {app}. Campos seguros nunca são gravados, nenhuma captura de tela é feita, e nada sai deste computador até você salvar. A bandeja do sistema também tem um botão Parar.",
      "voice.key.rightOption": "Alt direito",
      "voice.key.rightCommand": "Ctrl direito",
      "voice.settings.reviewHint":
        "Mantém o que o Psyche ouviu na janela pop-up para você corrigir e pressionar Enter. Desativado, é enviado quando você solta a tecla.",
      "meetingRecord.unavailable":
        "Gravar precisa de uma forma de transformar o áudio em notas (um modelo de fala ou o assistente do Linux), e nenhum está conectado.",
      "meetingRecord.micDenied":
        "O Psyche não pode usar o microfone. Permita nas Configurações do seu sistema.",
      "platform.term.os": "Linux",
      "platform.term.device": "computador",
      "platform.term.thisDevice": "Este computador",
      "platform.term.thisDeviceLower": "este computador",
      "platform.term.presence": "sua senha",
      "platform.term.secretStore": "Chaveiro do sistema",
      "platform.term.systemSettings": "Configurações",
      "platform.term.fileManager": "Arquivos",
      "platform.term.trayArea": "bandeja do sistema",
      "platform.term.taskbar": "barra de tarefas",
      "platform.term.systemSearch": "pesquisa da área de trabalho",
      "platform.term.helper": "assistente do Linux",
      "platform.term.terminal": "Terminal",
      "platform.term.alt": "Alt",
      "platform.term.mod": "Ctrl",
      "web.security.banner.recovery":
        "{count, plural, one {Uma alteração de segurança pedida neste computador será aplicada em {when}, a menos que você a cancele.} other {# alterações de segurança pedidas neste computador estão aguardando. A próxima será aplicada em {when}.}}",
      "web.security.alert.changed":
        "Um programa neste computador alterou {count, plural, one {1 registro de segurança} other {# registros de segurança}} sem passar pelo Psyche. O Psyche {count, plural, one {o restaurou} other {os restaurou}}. Se não foi você, verifique se há software indesejado no computador.",
      "web.security.alert.untrusted":
        "A verificação dos registros de segurança do Psyche falhou. Novos dispositivos, configurações de segurança e aprovações por senha estão bloqueados. Revise seus dispositivos e depois execute psyched security reseal no computador; isso é aplicado após 24 horas.",
      "web.security.alert.firstAdmin":
        "Um comando neste computador tornou {name} o primeiro dispositivo administrador. Se não foi você, revogue-o em Dispositivos.",
      "web.security.alert.requested": "Pedido neste computador: {action} Será aplicado em {when}.",
      "web.security.op.presenceReset":
        "deixar de exigir a sua senha ou uma chave-senha para alterações de segurança até que uma nova chave seja registrada.",
      "web.security.needsApproval":
        "Aprove o cartão com a sua senha ou uma chave-senha e toque no botão de novo.",
    },
    zh: {
      "settings.devices.nodeKind.hostHelper": "Linux 助手",
      "settings.links.description":
        "聊天消息、卡片或制品中的链接在哪里打开。按住 Ctrl 点击始终使用默认浏览器。",
      "errors.presence_required": "请先用密码或通行密钥确认是你本人。",
      "chat.toolbar.keySheet": "Ctrl+Shift+A",
      "chat.toolbar.keyModel": "Ctrl+Shift+I",
      "chat.toolbar.keyView": "Ctrl+O",
      "chat.approval.keysHint": "Ctrl+Enter {allows} · Ctrl+D {denies}",
      "blocks.details.runsOnHost": "你的电脑上，沙盒之外",
      "blocks.details.runsSandboxed":
        "在你的电脑上、沙盒内运行：无法读取 Psyche 的保险库、你的 SSH 密钥、系统密钥环或浏览器配置文件",
      "blocks.details.runsNoSandbox": "在你的电脑上运行，且沙盒尚未设置（{reason}）",
      "blocks.permission.need.capability": "开启“在此电脑上运行命令”",
      "blocks.permission.need.macos_access": "在设置中授予 {connector} 访问权限",
      "blocks.permission.openSystemSettings": "打开设置",
      "blocks.approval.answerOnHost":
        "请在 {host} 上回答，或在“设置 → 设备”中为这台电脑设置密码批准。",
      "blocks.approval.needsAuth": "批准需要密码或通行密钥。",
      "blocks.approval.touchIdFailed": "密码验证失败：{reason}。请重试。",
      "blocks.approval.touchIdFailedNoReason": "密码验证失败，请重试。",
      "blocks.approval.touchId.helperOffline": "Linux 助手未运行，因此无法在此处用密码确认。",
      "blocks.approval.touchId.noKey":
        "这台电脑尚未设置密码批准。请在“设置 → 设备”中设置，你可以先检查密钥。",
      "blocks.approval.touchId.invalidated":
        "自这台电脑的密钥设置以来你的密码设置已发生变化，因此无法确认批准。请在“设置 → 设备”中重新设置。",
      "blocks.approval.touchId.noUnsandboxed":
        "无法在此窗口用密码批准不用沙盒运行命令。请改为设置沙盒",
      "blocks.approval.touchId.onceOnly": "从此窗口进行的密码批准只有一次有效。",
      "blocks.approval.status.allowedOnceTouchId":
        "已允许一次（从此窗口进行的密码批准只有一次有效）",
      "blocks.approval.touchId.keyUnavailable":
        "此版本的 Linux 助手无法保存批准密钥，因此需要密码的卡片无法在这台电脑上批准。",
      "blocks.approval.touchId.cancelled": "密码提示已取消，因此没有批准任何内容",
      "shell.shortcut.pushToTalkKeys": "按住右 Ctrl",
      "settings.shared.needsPresence":
        "更改“{label}”需要你通过密码或通行密钥批准。请在“设置”或 Psyche 通知中批准，然后再次更改。",
      "settings.page.permissions.description":
        "{persona}在这台电脑上无需询问就可执行的操作，以及它一定会停下来问你的地方。",
      "settings.page.data.description":
        "哪些内容保留在这台电脑上、保留多久、导出、备份以及重新开始。",
      "settings.essentials.model.noneHint":
        "{persona}需要有模型才能回答。请添加密钥，或使用这台电脑上的模型。",
      "settings.essentials.read.hint":
        "在你开启之前都是关闭的。它读取的内容会在这台电脑上建立索引，方便它为你查找；除非你在“记忆 → 来源”中选择退出，记忆也会从中学习。",
      "settings.searchModel.apple.notOnThisMac": "在 macOS 上可用",
      "settings.macHelper.paired.text":
        "在这台电脑上运行电脑使用、屏幕上下文、听写、密码批准和通知。",
      "settings.macHelper.unbundled.text": "此版本的 Psyche 不包含 Linux 助手。",
      "settings.key.appearance.showInDock": "没有打开窗口时在任务栏中显示",
      "settings.semanticSearch.encrypt.pending": "正在等待 Linux 助手打开加密索引",
      "settings.semanticSearch.rerankHint":
        "由一个小型云端模型把最佳结果排在前面。前 20 条摘要会离开这台电脑。默认关闭。",
      "settings.key.vm.enabled": "使用沙盒电脑运行任务",
      "settings.key.vm.resetPerTask": "每个任务使用全新的电脑",
      "settings.credentials.backend.psyche": "Psyche 保险库（你的密码）",
      "settings.credentials.backend.keychain": "系统密钥环",
      "settings.credentials.backendIn.keychain": "在系统密钥环中",
      "settings.credentials.err.lockedChange":
        "保险库已锁定。请用你的密码解锁，然后再次{verb, select, delete {删除} other {更改}} {name}。",
      "settings.credentials.err.lockedImport": "保险库已锁定。请用你的密码解锁，然后重新导入。",
      "settings.credentials.slot.keychain": "系统密钥环（你的密码）",
      "settings.credentials.slot.safeStorage": "这台电脑的 App 存储空间",
      "settings.credentials.slot.keyFile": "这台电脑上的密钥文件",
      "settings.credentials.moveToKeychain": "移至系统密钥环",
      "settings.credentials.keyFileExplainer":
        "打开保险库的密钥是一个只有你的账户能读取的文件。将其移至系统密钥环需要 Linux 助手；此版本的助手不可用。",
      "settings.credentials.link.err.locked":
        "保险库已锁定。请用你的密码解锁，然后重新链接 {name}。",
      "settings.approval.presenceUnavailable":
        "此窗口无法确认是你本人。请在电脑上的 Psyche App 中批准此更改（你的密码），或使用带通行密钥的设备批准。在此之前不会有任何更改。",
      "settings.approval.promptDetail":
        "安全设置需要你的密码或通行密钥。可在此处或在 Psyche 通知中批准；批准后设置会立即存储。",
      "settings.approval.presenceInvalid": "你的密码或通行密钥未能确认是你本人。请再试一次。",
      "settings.about.revealHome": "在“文件”中显示",
      "settings.uninstall.keychainStays":
        "系统密钥环项目会保留（保险库密钥和辅助程序的项目）。如有需要，请在你的密钥环应用中移除。",
      "settings.uninstall.keychainGoes": "保险库和辅助程序的系统密钥环项目也会被移除。",
      "settings.uninstall.removeKeychain":
        "同时移除我的系统密钥环项目（Psyche 的那些项目）。没有你的数据，它们毫无用处。",
      "settings.uninstall.presence": "之后会请你用密码或在此设备上确认，因为这会移除你的数据。",
      "settings.appearance.showInDockHint":
        "关闭后，最后一个窗口关闭时 Psyche 会继续在系统托盘中运行。",
      "settings.appearance.openAtLoginHint":
        "登录时在系统托盘中启动 Psyche，让计划自动化始终能够运行。",
      "settings.browser.letTasksUseHint": "每个任务仍会先在此设备上通过密码或通行密钥向你询问。",
      "settings.browser.detailsText":
        "任务使用它时，Psyche 会以此描述文件运行 Google Chrome，并在这台电脑的回环地址（127.0.0.1）上开启 DevTools 端口，任务完成后关闭。你自己打开该描述文件时，{persona} 不会连接。",
      "settings.browser.openFromMac": "请在运行 Gateway 的电脑上的 Psyche App 中打开。",
      "settings.channels.empty":
        "还没有渠道。连接 Telegram 或 Slack，即可在离开这台电脑时联系 {persona}。",
      "settings.computerUse.description": "{persona} 只能在你允许的范围内使用这台电脑上的 App。",
      "settings.computerUse.macPermissions": "桌面权限",
      "settings.computerUse.openSystemSettingsFor": "打开{name}的设置",
      "settings.computerUse.openSystemSettings": "打开设置",
      "settings.trusted.loading": "正在从这台电脑读取…",
      "settings.trusted.noHelper": "请在电脑上打开 Psyche 以列出它们：由助手读取。",
      "settings.trusted.failed": "Psyche 无法从这台电脑读取它们。",
      "settings.mcp.sandboxHelp": "命令类服务器需要这台电脑上有沙盒。",
      "settings.sandbox.why":
        "命令在你的电脑上运行，可以使用你的文件，但无法读取你的保险库、密钥或 Psyche 的私有数据。",
      "settings.sandbox.whyHow":
        "在 Linux 自带的沙盒机制（bubblewrap）之上使用 Anthropic 的沙盒运行时 srt。无需虚拟机。",
      "settings.sandbox.checking": "正在检查这台电脑…",
      "settings.sandbox.containers.body":
        "容器运行时会在自己的 Linux 机器中运行代码，无法访问你电脑上的文件：用于代理运行的代码和部分文件转换。除非 Gateway 设为使用容器，命令类服务器仍使用 srt。",
      "settings.searchSources.description":
        "Psyche 会把哪些内容读入你的搜索索引。在你开启之前全部关闭；索引保留在这台电脑上。开启某个来源也会让记忆从中学习，除非你在“记忆 → 来源”中选择退出（记忆和通讯录例外：这两项都不会被学习）。",
      "settings.searchSources.runOnBatteryHint":
        "让索引、重建和读取图片中的文字在你的电脑使用电池时也以更温和的节奏继续。会更耗电。节能模式仍会暂停索引。",
      "settings.searchSources.ocrHint":
        "在接通电源时（或开启“使用电池时建立索引”后在电池供电时）逐页读取截屏和扫描版 PDF。任何内容都不会离开你的电脑。",
      "settings.semanticSearch.description": "不仅按字词，也按含义查找内容，全部在这台电脑上完成。",
      "settings.semanticSearch.engine.builtinHint":
        "Multilingual E5 small，支持约 100 种语言，在这台电脑的处理器上运行。",
      "settings.semanticSearch.engine.routerHint":
        "使用“角色”中设置的嵌入模型，例如这台电脑上的 Ollama 或 LM Studio。",
      "settings.semanticSearch.allowCloudHint":
        "仅当嵌入模型是云端服务时适用。你的聊天、任务和资料库文本会发送给它。关闭则一切都保留在这台电脑上。",
      "settings.semanticSearch.state.cloudBlocked":
        "“角色”中的嵌入模型是云端服务。语义搜索只使用这台电脑上的模型。",
      "settings.data.encryptMemory.pending": "正在等待 Linux 助手提供密钥。",
      "settings.devices.touchId.none": "还没有密码密钥。注册密钥之前，需要你的密码的卡片无法批准。",
      "settings.devices.touchId.noBundledKey": "此 App 中的 Linux 助手没有批准密钥（{reason}）。",
      "settings.devices.touchId.manualHint":
        "在电脑上运行 psyche-helper --print-identity，并粘贴它输出的 presenceKeyId。",
      "settings.devices.noNodes": "没有节点。Psyche 在这台电脑上运行后，Linux 助手会出现在这里。",
      "settings.files.execHost": "在这台电脑上运行命令",
      "settings.files.execHostSwitch": "允许在这台电脑上运行命令",
      "settings.model.ram.tooSmall":
        "这台电脑有 {gb, number} GB。本地模型至少需要 {min, number} GB；请改用云端提供商。",
      "settings.model.ram.fits": "这台电脑有 {gb, number} GB，可运行{fits}。",
      "settings.model.ram.thisMac": "（这台电脑）",
      "settings.model.localHint": "通过 Ollama 或 LM Studio 在这台电脑上运行模型。",
      "settings.permissions.never.browserPasswords": "读取浏览器或系统密钥环中保存的密码",
      "settings.server.bindHint":
        "127.0.0.1 使其仅限这台电脑。请使用下方的远程访问，而不是绑定到所有网络接口。",
      "settings.gateways.description":
        "在这台电脑上使用另一台电脑（比如你家里的电脑）上的 Gateway 来使用 Psyche。同一时间只有一个 Gateway 处于活动状态，切换会重启 Psyche。",
      "settings.gateways.thisMac": "这台电脑",
      "settings.gateways.switchKeep":
        "Psyche 将在{name}上重启。这台电脑上的 Psyche 会继续运行，因此其自动化也会继续。",
      "settings.gateways.switchAndStop": "切换并停止这台电脑上的 Psyche",
      "settings.gateways.addHint":
        "粘贴运行 Psyche 的电脑上的配对链接（设置 → 服务器与远程访问 → 配对另一台电脑）。没有链接时，请输入它的 Tailscale 地址 https://<host>.<tailnet>.ts.net；这台电脑随后会请求配对，由所有者在那边批准。",
      "settings.gateways.problem.link_malformed": "该配对链接已损坏。请从生成它的电脑上重新复制。",
      "settings.gateways.problem.link_bad_field": "该配对链接已损坏。请从生成它的电脑上重新复制。",
      "settings.gateways.problem.link_lan":
        "此配对链接指向本地网络中的一台电脑，但没有附带它的证书，因此不会使用。请在那台电脑上重新生成：配对另一台电脑 → 从此网络。",
      "settings.remote.description":
        "让另一台电脑上的 Psyche 通过 Tailscale 使用这台电脑的 Gateway。Gateway 仍留在这台电脑上，只监听 Tailscale，Tailscale Serve 是唯一的入口。",
      "settings.remote.step1": "在这台电脑和另一台电脑上都安装 Tailscale，并登录到同一个 tailnet。",
      "settings.remote.step2":
        "在这台电脑的终端中，把 Gateway 发布到你的 tailnet。这里用的是 Serve，不是 Funnel。",
      "settings.remote.step4":
        "重启 Psyche。然后在另一台电脑上，把这台电脑添加为 Gateway。它会显示配对码和密钥指纹：请与这里“等待配对”下的请求核对，然后批准。",
      "settings.remote.admin":
        "配对的电脑可获得读取、写入和批准权限。管理员权限默认关闭，除非你在批准时勾选；每次管理员更改仍需你在这里用密码确认。",
      "settings.pair.needsAddress": "请先设置这台电脑的公开地址（上面的第 3 步），再生成配对链接。",
      "settings.pair.adminHint":
        "管理员权限允许其更改安全设置、设备和保险库，默认关闭，除非你勾选。每次管理员更改仍需你在这里用密码确认。",
      "settings.pair.compare":
        "它在使用链接之前会核对这台电脑的密钥：{fingerprint}。你也可以核对。",
      "settings.pair.secret":
        "未来十分钟内，任何拿到这条链接的人都可以配对一台电脑。请勿发布，也不要发给你不放心让其使用这台电脑的人。",
      "settings.pair.err.noAddress": "这台电脑还没有公开地址，所以没有内容可放入链接。",
      "settings.pair.viaAddress": "通过 Tailscale，使用这台电脑的地址",
      "settings.pair.viaLanHint":
        "此网络的链接包含这台电脑的密钥和证书，因此只对同一 Wi-Fi 或以太网上的电脑有效。",
      "settings.pair.lanNote":
        "此链接适用于与这台电脑处于同一网络的电脑。它指明了 Psyche 将要求的密钥和证书。",
      "settings.lan.description":
        "让同一 Wi-Fi 或以太网上另一台电脑的 Psyche 无需 Tailscale 就能访问这台电脑的 Gateway。开启之前一直处于关闭状态。",
      "settings.lan.toggleHint":
        "Psyche 在一个网络上监听，使用带有自身证书的加密连接。连接的电脑仍需在这里通过你的密码批准。",
      "settings.lan.noInterface": "在这台电脑上没有找到 Wi-Fi 或以太网连接。",
      "settings.lan.notAdvertised": "不显示。请通过地址添加这台电脑。",
      "settings.lan.problem.unknownInterface": "{name} 不是这台电脑上的网络。",
      "settings.lan.problem.advertise":
        "Psyche 无法在网络上宣告自己。电脑仍可通过地址添加这台电脑。",
      "settings.server.noVm":
        "没有虚拟机。虚拟机模式在独立的客户机电脑中运行 Psyche；请在初始设置中进行设置。",
      "settings.shortcut.key.Control": "Ctrl",
      "settings.shortcut.key.Alt": "Alt",
      "settings.skills.permission.exec_host": "在这台电脑上运行命令",
      "settings.skills.permission.computer_action": "使用这台电脑上的 App",
      "settings.skills.pathPlaceholder": "/home/you/Downloads/pdf-merge",
      "settings.skills.signer.originAgent":
        "由发送者电脑上的助手编写。无论是谁签名，都请当作未经审阅的文本来读。",
      "settings.skills.export.hint":
        "文件会用你的作者密钥签名，让收到它的人能确认这是你的，并且没有被改动。密钥保留在这台电脑上。",
      "settings.vm.phase.installing": "正在设置客户机",
      "settings.vm.description":
        "在独立的沙盒电脑中运行任务，让 {persona} 在它自己的 Linux 副本中工作，而不是在你的系统中。",
      "settings.vm.sandboxMac": "沙盒电脑",
      "settings.vm.between": "你的电脑与客户机之间",
      "settings.vm.credentialsHint":
        "使用主机保险库时，数值留在你的电脑上。客户机保险库则保留自己的副本。",
      "settings.vm.noReports":
        "还没有客户机报告。请在这台电脑上通过 Psyche 助手创建一个；其状态会显示在这里。",
      "settings.voice.key.rightOption": "右 Alt",
      "settings.voice.key.rightCommand": "右 Ctrl",
      "settings.voice.reply.gatewayHint": "为角色设置的声音，或系统声音。",
      "settings.voice.engine.local": "在这台电脑上",
      "settings.voice.engine.localHint": "Whisper 在本地运行；音频从不离开这台电脑。",
      "settings.voice.engine.system": "系统听写",
      "settings.voice.engine.systemHint": "系统的设备端识别器，通过 Linux 助手使用。",
      "settings.voice.model.usingHelper":
        "听写使用助手的语音识别。语音模型转写效果更好，并在这台电脑上运行。",
      "settings.voice.model.downloadHint":
        "从 whisper.cpp 项目一次性下载，使用前会经过校验。音频从不离开这台电脑。",
      "settings.voice.model.ready": "这台电脑上的 Whisper（{model}）",
      "settings.voice.model.readyHint": "听写和录音在此转写；音频从不离开这台电脑。",
      "settings.connect.finishOpened":
        "登录 {name} 的页面已在 Gateway 所在电脑的浏览器中打开。完成后此处会更新。",
      "settings.connect.needsPermission": "{name} 已设置，但系统尚未允许它。请在以下位置允许：",
      "settings.connect.openSystemSettings": "打开设置",
      "settings.people.description":
        "{persona}为你生活中的人物和项目保留的卡片。它们留在这台电脑上，每条事实都会显示来源。",
      "settings.about.versionsHint": "这台电脑上正在运行的内容。",
      "settings.computerUse.macPermissionsHint": "桌面已允许的内容。",
      "settings.connectorBundle.sandbox.none":
        "这台电脑没有用于命令连接器的沙盒，而 Psyche 绝不会在沙盒之外运行它们。此连接器无法在这里安装。没有启动或保存任何内容。",
      "settings.connectorBundle.share.unavailable":
        "只有运行该连接器的电脑上的 Psyche 才能为其签名。",
      "settings.deviceAccess.files.title": "这台电脑上的文件",
      "settings.deviceAccess.terminal.hint":
        "“权限 → 访问”中开启“在这台电脑上运行命令”后，{persona}可以在这台电脑上运行终端命令。",
      "settings.deviceAccess.terminal.where":
        "命令在你的电脑上、在你共享的文件夹中运行，并且只能写入你以读写方式共享的文件夹。",
      "settings.mcp.needs.title": "这需要你的电脑具备什么",
      "settings.mcp.needs.node.fix":
        "在 Psyche 自带的 Node 上运行；这台电脑上需要 npm。请从 nodejs.org 安装 Node.js，或使用你的包管理器安装。",
      "settings.mcp.needs.uv.fix": "这是 Python 服务器。请从 docs.astral.sh/uv 安装 uv。",
      "settings.mcp.fail.node_missing":
        "请安装 Node.js（nodejs.org，或使用你的包管理器），让这台电脑上有 npm，然后重新检查。",
      "settings.mcp.fail.uv_missing": "请安装 uv（docs.astral.sh/uv），然后再次检查服务器。",
      "settings.mail.voice.learn.hint":
        "Wren 只读取你在已发送邮件中亲自写的内容，不含引用文字和签名。档案保存在这台电脑上的 mail/VOICE.md 中。",
      "settings.mail.voice.localModel.hint": "用你的风格起草的内容不会离开这台电脑。",
      "settings.mail.transcribe.endpoint.hint":
        "可选。支持 /v1/audio/transcriptions 的 OpenAI 兼容服务器(例如此电脑上的 whisper.cpp)。在 Linux 助手没有语音引擎时使用。音频只会发送到此地址:https,或 127.0.0.1 上的 http。",
      "onboarding.mail.voiceHint":
        "只读取你亲自写的内容，不含引用文字和签名。内容仅保存在这台电脑上，你可以查看、编辑或重置。",
      "gallery.preset.git.field.repo.help":
        "这台电脑上 Git 代码库的文件夹。Psyche 可以读取它的历史和差异。",
      "settings.connectors.page.onThisMac": "在这台电脑上",
      "settings.connectors.page.row.local": "在这台电脑上运行",
      "settings.connectors.page.server.local": "在这台电脑的沙盒中运行的工具",
      "onboarding.permission.denied": "已在设置中关闭",
      "onboarding.permission.deniedHint": "请在系统设置中打开；你回来时此页面会更新。",
      "onboarding.permission.unavailableHint": "Psyche 只能在 Psyche 桌面 App 中请求此权限。",
      "onboarding.connectors.onThisMac": "在这台电脑上",
      "onboarding.connectors.onThisMacHint": "每个 App 在连接时会逐个向系统请求权限。",
      "onboarding.model.kind.localHint": "在这台电脑上运行；任何内容都不会离开它。",
      "onboarding.model.subscriptionNote":
        "Psyche 使用这台电脑上已登录的 Claude Code 或 Codex App，因此不需要也不存储 API 密钥。如果尚未登录，请先在那里登录。",
      "onboarding.safety.touchId": "用你的密码批准",
      "onboarding.safety.touchId.checking": "正在检查 Linux 助手…",
      "onboarding.safety.touchId.setHint": "需要你批准的操作会请你输入密码。",
      "onboarding.safety.touchId.starting": "Linux 助手仍在启动。请稍后再检查。",
      "onboarding.safety.touchId.noKey": "Linux 助手没有批准密钥（{reason}）。",
      "onboarding.safety.touchId.hint": "注册一次 Linux 助手的密钥，你的密码才能确认批准。",
      "onboarding.safety.asks":
        "如果你让{name}在这台电脑上运行命令，只读取内容的命令（如 ls 或 cat）无需卡片即可运行。其他任何命令都会先询问你。",
      "onboarding.done.touchId": "你的密码",
      "onboarding.done.try.search":
        "在“搜索”（Ctrl+K）中提个问题。答案会显示它来自你生活中的哪里。",
      "screens.search.source.revealFile": "在“文件”中显示",
      "everything.model.localHint":
        "由这台电脑上的模型读取一切。没有任何内容离开电脑。事实更少，也更杂乱。",
      "everything.run.reason.battery":
        "现在不行：电脑正在使用电池。请接通电源，或允许电池供电时运行。",
      "everything.run.reason.thermal": "现在不行：电脑温度过高。",
      "everything.run.reason.not_idle": "现在不行：你正在使用电脑。",
      "everything.storage.note": "所有内容都只存储在这台电脑上。",
      "memoryWork.consent.k1": "没有任何内容离开这台电脑。日期和状态由代码计算得出。",
      "screens.library.reveal": "在“文件”中显示",
      "web.zoom.description":
        "App 在这台电脑上的显示大小。Ctrl+加号和 Ctrl+减号更改的是同一设置，因此重新启动后仍然保留；{min, number}–{max, number} %。",
      "web.transcriptMode.optionTitle": "{mode}（Ctrl+O 循环切换）",
      "web.backups.restore": "在新电脑上停止 Gateway 后恢复：",
      "web.passkeys.firstApproval":
        "请在你的电脑上用密码或在另一台设备上用通行密钥批准“添加通行密钥”，然后再次点按“添加”。",
      "web.passkeys.added": "已添加 {name}。它现在可以批准需要你的密码或通行密钥的更改。",
      "web.remotePresence.title": "用你的密码批准",
      "web.remotePresence.description":
        "购买、填写凭证、主机命令和安全更改都需要你的密码或通行密钥。在这台电脑上设置后即可在此回答；在此之前，这些卡片会提示在{host}上回答。普通批准从不需要它。",
      "web.remotePresence.on": "这台电脑已开启密码批准。",
      "web.remotePresence.off": "这台电脑尚未设置密码批准。",
      "web.remotePresence.enable": "在这台电脑上使用你的密码批准",
      "web.remotePresence.waiting": "正在等待你的密码…",
      "web.remotePresence.passkeyName": "这台电脑上的你的密码",
      "web.remotePresence.enabled": "这台电脑已开启密码批准。",
      "web.remotePresence.disabled": "这台电脑已关闭密码批准。",
      "web.remotePresence.approveOnHost":
        "请在{host}上用其 Touch ID、Windows Hello 或密码，或通行密钥批准“添加通行密钥”，然后再次点按该按钮。",
      "web.remotePresence.unavailable":
        "密码批准需要{host}的 Gateway 使用 https:// 地址（gateway.publicOrigin）。在此之前，请在{host}上回答这些卡片。",
      "web.webauthn.noPasskeyYet":
        "此浏览器还没有通行密钥。请在“设置 → 设备”中添加，或在运行 Gateway 的电脑上批准。",
      "web.webauthn.needsOrigin":
        "通行密钥需要服务器的 https 地址（gateway.publicOrigin）。请改为在运行 Gateway 的电脑上批准。",
      "web.setup.gatewayOk": "正在这台电脑上运行。",
      "web.setup.adminOk": "这台电脑是管理员设备。",
      "web.viewers.noSandbox": "幻灯片预览需要沙盒，但没有可用的容器运行时（Docker 或 Podman）。",
      "web.voice.noEngine":
        "没有可用的语音引擎。请在“设置 → 语音”中安装语音模型，或连接 Linux 助手。",
      "web.threads.newSideChatTitle": "新建支线聊天（Ctrl+N）",
      "web.panes.closePaneTitle": "关闭面板（Ctrl+\\）",
      "web.chat.permissionModeTitle": "权限模式（Ctrl+Shift+M）",
      "web.chat.modelTitle": "模型（Ctrl+Shift+I）",
      "web.splash.installing": "正在这台电脑上设置 Psyche…",
      "web.splash.helper": "正在你的电脑上准备 Psyche…",
      "web.splash.remote.useThisMac": "使用这台电脑",
      "web.remote.thisMac": "这台电脑",
      "web.teach.bar.body":
        "Psyche 只记录你在此标签页中的点按和输入。密码、卡号和验证码绝不会被记录，在你存储之前也没有任何内容离开这台电脑。",
      "settings.teach.storage.description":
        "当你要求 Psyche 保留录制以便制作另一个版本时，这些步骤会保存在这台电脑上。",
      "settings.teach.storage.encrypted":
        "已加密。文件由系统密钥环中的密钥锁定，因此无法在 Psyche 之外读取。90 天后过期。",
      "settings.teach.storage.unavailable":
        "不保留录制。系统密钥环不可用，而 Psyche 不会以明文保存录制。你仍然可以把录制存为技能。",
      "web.teach.review.keepUnavailable": "不可用：系统密钥环不可用，无法加密保留的录制。",
      "web.teach.review.keepRecording": "将此录制保留在这台电脑上，以便我制作另一个版本",
      "web.teach.app.recordHint": "向 Psyche 演示如何在你已允许的 App 中完成某件事",
      "web.teach.app.bar.body":
        "Psyche 只会记录你在 {app} 中的点击、菜单选择和输入。安全字段绝不会被录制，不会截取屏幕，在你保存之前也不会有任何内容离开这台电脑。系统托盘中也有“停止”按钮。",
      "voice.key.rightOption": "右侧 Alt",
      "voice.key.rightCommand": "右侧 Ctrl",
      "voice.settings.reviewHint":
        "将 Psyche 听到的内容保留在弹出窗口中，方便你修改后按 Enter 发送。关闭时，松开按键即发送。",
      "meetingRecord.unavailable":
        "录制需要一种把音频转成笔记的方式（语音模型或 Linux 助手），但没有连接任何一种。",
      "meetingRecord.micDenied": "Psyche 无法使用麦克风。请在系统设置中允许。",
      "platform.term.os": "Linux",
      "platform.term.device": "电脑",
      "platform.term.thisDevice": "这台电脑",
      "platform.term.thisDeviceLower": "这台电脑",
      "platform.term.presence": "你的密码",
      "platform.term.secretStore": "系统密钥环",
      "platform.term.systemSettings": "设置",
      "platform.term.fileManager": "文件",
      "platform.term.trayArea": "系统托盘",
      "platform.term.taskbar": "任务栏",
      "platform.term.systemSearch": "桌面搜索",
      "platform.term.helper": "Linux 助手",
      "platform.term.terminal": "终端",
      "platform.term.alt": "Alt",
      "platform.term.mod": "Ctrl",
      "web.security.banner.recovery":
        "{count, plural, other {在这台电脑上请求的 # 项安全更改正在等待。除非你取消，下一项将于 {when} 生效。}}",
      "web.security.alert.changed":
        "这台电脑上的某个程序绕过 Psyche 更改了 {count} 条安全记录。Psyche 已将其恢复。如果不是你做的，请检查这台电脑上是否有不需要的软件。",
      "web.security.alert.untrusted":
        "Psyche 的安全记录检查失败。新设备、安全设置和密码批准已被阻止。请检查你的设备，然后在电脑上运行 psyched security reseal；它将在 24 小时后生效。",
      "web.security.alert.firstAdmin":
        "这台电脑上的一条命令将 {name} 设为第一台管理员设备。如果不是你做的，请在“设备”中撤销它。",
      "web.security.alert.requested": "在这台电脑上请求：{action} 将于 {when} 生效。",
      "web.security.op.presenceReset": "在注册新密钥之前，安全更改不再需要你的密码或通行密钥。",
      "web.security.needsApproval": "请用你的密码或通行密钥批准卡片，然后再次按下按钮。",
    },
  };
