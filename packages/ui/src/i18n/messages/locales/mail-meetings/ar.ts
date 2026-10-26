import type { Catalogue } from "../../index.ts";

/** Mail and meeting settings and onboarding strings (ar); merged into `../ar.ts`. */
export const mailMeetings: Partial<Catalogue> = {
  "settings.nav.mail": "البريد والاجتماعات",
  "settings.mail.title": "البريد والاجتماعات",
  "settings.mail.description":
    "ما تفعله Wren ببريدك وتقويمك. تحفظ المسودات وتقترح الإجراءات؛ ولا يُرسَل شيء ولا يُشارَك ولا يُقبَل ولا يُرفَض دون موافقتك.",
  "settings.mail.quietHours": "ساعات الهدوء في الإشعارات.",
  "settings.mail.loadFailed": "تعذّر تحميل إعدادات البريد والاجتماعات.",

  "settings.mail.group.master": "الكل دفعة واحدة",
  "settings.mail.group.accounts": "الحسابات",
  "settings.mail.group.digest": "ملخص البريد الوارد",
  "settings.mail.group.followups": "المتابعات",
  "settings.mail.group.style": "أسلوب الكتابة",
  "settings.mail.group.scheduling": "الجدولة",
  "settings.mail.group.prep": "التحضير للاجتماعات",
  "settings.mail.group.notes": "ملاحظات الاجتماعات",
  "settings.mail.group.polling": "التحقق من البريد الجديد",

  "settings.mail.paused.hint": "يوقف كل مهام البريد والاجتماعات إلى أن تعيد تشغيلها.",
  "settings.mail.readOnly.hint":
    "تستمر الملخصات والتحضيرات بالوصول. لا تقترح Wren إجراءات ولا تكتب مسودات.",

  "settings.mail.accounts.none": "لا يوجد حساب بريد متصل. اربط حسابًا من الموصِّلات.",
  "settings.mail.accounts.use": "استخدام {account} في الملخص والمتابعات",
  "settings.mail.accounts.connect": "فتح الموصِّلات",

  "settings.mail.digest.time": "الوقت",
  "settings.mail.digest.days": "الأيام",
  "settings.mail.digest.days.weekdays": "أيام العمل",
  "settings.mail.digest.days.everyday": "كل يوم",
  "settings.mail.digest.onlyWhenNeeded.hint": "في الأيام الهادئة يصل الملخص إلى الخلاصة دون تنبيه.",
  "settings.mail.digest.rules": "قواعد المرسلين",
  "settings.mail.digest.rulesHint": "من يُؤرشَف دائمًا ومن يُسمح له دائمًا ومن يُفحَص.",
  "settings.mail.digest.openRules": "فتح",
  "settings.mail.digest.openRulesAsk": "اعرض لي mail/RULES.md.",

  "settings.mail.followups.waitDays": "الانتظار قبل الظهور",
  "settings.mail.followups.days":
    "{n, plural, zero {# يوم عمل} one {يوم عمل واحد} two {يوما عمل} few {# أيام عمل} many {# يوم عمل} other {# يوم عمل}}",
  "settings.mail.followups.showTwice.hint": "بعد ملخصين تصمت.",

  "settings.mail.voice.learn.hint":
    "تقرأ Wren ما كتبتَه فقط في البريد المُرسَل، دون النص المقتبس أو التوقيعات. يبقى الملف الشخصي على هذا الـ Mac في mail/VOICE.md.",
  "settings.mail.voice.profile": "ملف الأسلوب",
  "settings.mail.voice.view": "عرض",
  "settings.mail.voice.edit": "تعديل",
  "settings.mail.voice.reset": "إعادة ضبط",
  "settings.mail.voice.viewAsk": "اعرض لي mail/VOICE.md.",
  "settings.mail.voice.editAsk": "دعني أعدّل mail/VOICE.md.",
  "settings.mail.voice.resetAsk":
    "أعد ضبط ملف أسلوب كتابتي: احذف mail/VOICE.md و mail/voice-samples.jsonl.",
  "settings.mail.voice.localModel.hint": "المسودات بأسلوبك لا تغادر هذا الـ Mac أبدًا.",
  "settings.mail.voice.localModel.none": "استخدام النموذج الأساسي",
  "settings.mail.voice.localModel.empty": "لم يُعدّ أي نموذج محلي.",

  "settings.mail.schedule.hours": "ساعات العمل",
  "settings.mail.schedule.hoursHint": "من USER.md. تُقترح المواعيد ضمن هذه الساعات في أيام العمل.",
  "settings.mail.schedule.hoursFrom": "من",
  "settings.mail.schedule.hoursTo": "إلى",
  "settings.mail.schedule.buffer.hint": "فسحة تُترك حول الاجتماعات عند اقتراح المواعيد.",
  "settings.mail.schedule.minutes":
    "{n, plural, zero {# دقيقة} one {دقيقة واحدة} two {دقيقتان} few {# دقائق} many {# دقيقة} other {# دقيقة}}",
  "settings.mail.schedule.noBuffer": "بلا",
  "settings.mail.schedule.focusTime.hint": "اقتراح حجز فترة للعمل المركّز.",
  "settings.mail.schedule.link.hint": "اختياري. يُضاف إلى الردود إن كان لديك رابط.",

  "settings.mail.prep.scope.hint": "يتخطى الاجتماعات التي تضم فريقك وحده.",
  "settings.mail.prep.leadMin": "التحضير قبل الاجتماع",
  "settings.mail.prep.notifyMin": "نبّهني قبل البدء",
  "settings.mail.prep.saveToNotes.hint": "يحفظ ملاحظة التحضير أيضًا في تطبيق ملاحظاتك.",
  "settings.mail.prep.dailyCap": "الحد الأقصى للتحضيرات يوميًا",
  "settings.mail.prep.calendars": "يشمل التحضير التقويمات التي ربطتها في الموصِّلات.",

  "settings.mail.notes.enabled.hint":
    "لا يفعل شيئًا حتى تضيف صوتًا: مذكرة صوتية أو ملفًا أو تسجيلًا تبدؤه.",
  "settings.mail.notes.folder": "مجلد التسجيلات",
  "settings.mail.notes.folder.hint": "مجلد يمكن لـ Wren قراءته. امنحه الإذن من الوصول إلى الملفات.",
  "settings.mail.notes.folder.placeholder": "~/Documents/Recordings",
  "settings.mail.notes.tasksApp": "إضافة بنود العمل إلى",
  "settings.mail.notes.tasksApp.reminders": "التذكيرات",
  "settings.mail.notes.tasksApp.things": "Things",
  "settings.mail.notes.recap.hint": "يحفظ رسالة ملخص كمسودة بعد كل اجتماع.",
  "settings.mail.notes.consent.hint": "تُعرض قبل كل تسجيل تبدؤه. تنطق بها أو تلصقها في المكالمة.",
  "settings.mail.notes.consent.default": "أسجّل هذا لأجل ملاحظاتي. هل هذا مناسب؟",
  "settings.mail.notes.cloud.hint":
    "تحتوي النصوص المفرّغة على كلام الآخرين. عند الإيقاف تستخدم الملخصات نموذجًا محليًا، أو تسأل أولًا.",

  "settings.mail.poll.active": "أثناء نشاطك",
  "settings.mail.poll.idle": "في غير ذلك",
  "settings.mail.poll.hint": "عدد مرات بحث Wren عن بريد جديد. الأسرع يستهلك بطارية أكثر.",

  "settings.key.workflows.paused": "إيقاف كل مهام البريد والاجتماعات مؤقتًا",
  "settings.key.workflows.readOnly": "للقراءة فقط (الملخصات والتحضير فقط)",
  "settings.key.mail.accounts": "استخدام {account} في الملخص والمتابعات",
  "settings.key.mail.digest.enabled": "ملخص البريد الوارد",
  "settings.key.mail.digest.time": "وقت الملخص",
  "settings.key.mail.digest.days": "أيام الملخص",
  "settings.key.mail.digest.onlyWhenNeeded": "التنبيه فقط عند وجود ما يحتاج إليك",
  "settings.key.mail.followups.enabled": "تتبّع الردود التي تنتظرها",
  "settings.key.mail.followups.waitDays": "مدة انتظار المتابعة",
  "settings.key.mail.followups.showTwice": "عرض كل متابعة مرتين كحد أقصى",
  "settings.key.mail.voice.enabled": "التعلّم من البريد المُرسَل",
  "settings.key.mail.draft.localModel": "كتابة المسودات بنموذج محلي",
  "settings.key.mail.schedule.hoursStart": "بداية ساعات العمل",
  "settings.key.mail.schedule.hoursEnd": "نهاية ساعات العمل",
  "settings.key.mail.schedule.bufferMin": "فسحة بين الاجتماعات",
  "settings.key.mail.schedule.focusTime": "اقتراح وقت للتركيز",
  "settings.key.mail.schedulingLink": "رابط الجدولة",
  "settings.key.mail.poll.activeMin": "فحص البريد أثناء النشاط",
  "settings.key.mail.poll.idleMin": "فحص البريد في غير ذلك",
  "settings.key.meetings.prep.enabled": "التحضير للاجتماعات",
  "settings.key.meetings.prep.scope": "الاجتماعات مع أشخاص خارج نطاقي فقط",
  "settings.key.meetings.prep.leadMin": "المدة المسبقة للتحضير",
  "settings.key.meetings.prep.notifyMin": "المدة المسبقة لتنبيه التحضير",
  "settings.key.meetings.prep.saveToNotes": "حفظ التحضير أيضًا في الملاحظات",
  "settings.key.meetings.prep.dailyCap": "الحد الأقصى للتحضيرات يوميًا",
  "settings.key.meetings.notes.enabled": "ملاحظات الاجتماعات من التسجيلات",
  "settings.key.meetings.notes.folder": "مجلد التسجيلات",
  "settings.key.meetings.notes.tasksApp": "إضافة بنود العمل إلى",
  "settings.key.meetings.notes.recapDraft": "كتابة مسودة رسالة ملخص",
  "settings.key.meetings.notes.consentLine": "عبارة موافقة التسجيل",
  "settings.key.meetings.notes.cloudSummary": "التلخيص بنموذج سحابي",

  "onboarding.step.mail": "البريد والاجتماعات",
  "onboarding.mail.title": "يمكن لـ {name} أن تُطلعك على البريد والاجتماعات",
  "onboarding.mail.lead":
    "اختر ما تريد. لا يعمل شيء قبل أن تتابع، ويمكنك تغيير أي منها في الإعدادات.",
  "onboarding.mail.digest": "ملخص البريد الوارد الصباحي عند 7:30",
  "onboarding.mail.digestHint": "ملخص واحد يوميًا لما يحتاج إليك. لا يُرسل شيئًا أبدًا.",
  "onboarding.mail.prep": "ملاحظات تحضيرية قبل الاجتماعات مع أشخاص من خارج فريقك",
  "onboarding.mail.prepHint": "من هم، وما المفتوح، وما ناقشتماه في المرة السابقة.",
  "onboarding.mail.followups": "تتبّع الردود التي تنتظرها",
  "onboarding.mail.followupsHint": "تظهر في الملخص فقط. دون تنبيهات منفصلة.",
  "onboarding.mail.voice": "التعلّم من البريد المُرسَل لمعرفة أسلوب كتابتي",
  "onboarding.mail.voiceHint":
    "يقرأ ما كتبتَه فقط، دون النص المقتبس أو التوقيعات. يبقى على هذا الـ Mac ويمكنك عرضه أو تعديله أو إعادة ضبطه.",
  "onboarding.mail.notes": "ملاحظات الاجتماعات من التسجيلات",
  "onboarding.mail.notesHint":
    "لا يفعل شيئًا حتى تضيف صوتًا. لا يُرفع الصوت ولا النصوص المفرّغة ولا تُستخدم للتدريب أبدًا.",
  "onboarding.mail.summary":
    "{n, plural, =0 {لا شيء مفعّل} one {عنصر واحد مفعّل} two {عنصران مفعّلان} few {# عناصر مفعّلة} many {# عنصرًا مفعّلًا} other {# عنصر مفعّل}}",
  "onboarding.mail.done": "البريد والاجتماعات",
  "onboarding.mail.doneOff": "متوقف. يمكنك تفعيله من الإعدادات.",
  "onboarding.mail.doneOn":
    "{n, plural, one {مهمة واحدة مفعّلة} two {مهمتان مفعّلتان} few {# مهام مفعّلة} many {# مهمة مفعّلة} other {# مهمة مفعّلة}}",
};
