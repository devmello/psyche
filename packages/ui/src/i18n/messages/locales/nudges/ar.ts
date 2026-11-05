import type { Catalogue } from "../../index.ts";

/** nudges strings (ar); merged into `../ar.ts`. */
export const nudges: Partial<Catalogue> = {
  "settings.key.nudges.enabled": "تنبيهات العلاقات",
  "settings.key.nudges.consentedAt": "الموافقة على تنبيهات العلاقات",
  "settings.key.nudges.sensitivity": "عدد مرات التنبيه",
  "settings.key.nudges.phrasing": "إعادة صياغة اقتراحات التنبيه",
  "nudges.kind": "ابقَ على تواصل",
  "nudges.draftReply": "صياغة رد",
  "nudges.draftMessage": "صياغة رسالة",
  "nudges.snooze": "غفوة",
  "nudges.snoozeWeek": "لمدة أسبوع",
  "nudges.snoozeMonth": "لمدة شهر",
  "nudges.mutePerson": "ليس هذا الشخص",
  "nudges.done": "تم",
  "nudges.overdue": "متأخر",
  "nudges.moreActions": "طرق أخرى للتنحية: {name}",
  "nudges.result.done": "وُضعت علامة تم.",
  "nudges.result.snooze_week": "تم التأجيل أسبوعًا.",
  "nudges.result.snooze_month": "تم التأجيل شهرًا.",
  "nudges.result.mute_person": "لا مزيد من التنبيهات بشأن {name}. يمكنك إعادة تفعيلها من صفحته.",
  "nudges.gone": "لم يتبقَّ شيء لفعله هنا.",
  "nudges.failed": "لم يُحفظ ذلك: {reason}",
  "nudges.draft.unanswered":
    "ساعدني في الرد على {name}. وصلتني آخر {channel, select, mail {رسالة بريد} other {رسالة}} منه قبل {days} يومًا ولم أرد عليها. اطّلع على المحادثة ثم صغ ردًا قصيرًا لأقرأه. لا ترسل أي شيء.",
  "nudges.draft.drift":
    "لم أتحدث مع {name} منذ مدة. صغ رسالة قصيرة ودافئة يمكنني إرسالها للاطمئنان عليه. لا ترسل أي شيء.",
  "nudges.draft.birthday":
    "اقترب يوم {name} الخاص ({date}). صغ رسالة قصيرة ودافئة يمكنني إرسالها. لا ترسل أي شيء.",
  "nudges.draft.promise":
    "{text} ساعدني في المتابعة: صغ رسالة قصيرة إلى {name} بهذا الشأن. لا ترسل أي شيء.",
  "nudges.starters.title": "أمور يمكن طرحها",
  "nudges.draft.starters":
    "أمور يمكنني طرحها، مما يحتفظ به Psyche (استخدم هذه فقط ولا تختلق أي شيء آخر):",
  "nudges.settings.phrasing": "إعادة صياغة الاقتراحات بنموذجي",
  "nudges.settings.phrasingHint":
    "يستخدم النموذج الذي اخترته لذاكرة «كل شيء» ليعبّر عنها بكلمات ألطف. متوقف افتراضيًا.",
  "nudges.person.title": "ابقَ على تواصل",
  "nudges.person.none": "لا شيء للمتابعة.",
  "nudges.person.muted": "تنبيهات {name} متوقفة.",
  "nudges.person.unmute": "إعادة تفعيل التنبيهات",
  "nudges.settings.title": "البقاء على تواصل",
  "nudges.settings.description":
    "تذكيرات لطيفة بالأشخاص الذين انقطع تواصلك معهم، وبأعياد الميلاد والوعود التي قطعتها.",
  "nudges.settings.enabled": "ذكّرني بالبقاء على تواصل",
  "nudges.settings.enabledHint":
    "حتى ثلاثة تنبيهات في موجز الصباح، وبطاقات هادئة في الخلاصة. لا يُرسل شيء نيابةً عنك أبدًا.",
  "nudges.settings.sensitivity": "عدد المرات",
  "nudges.settings.sensitivityHint": "المدة التي تنتظرها الرسالة قبل أن يقول Psyche شيئًا.",
  "nudges.settings.low": "لطيف",
  "nudges.settings.normal": "عادي",
  "nudges.settings.high": "متحمّس",
  "nudges.settings.quietHours":
    "تنتظر البطاقات انتهاء ساعات الهدوء المضبوطة في الإعدادات ← عام ← الإشعارات.",
  "nudges.consent.title": "تفعيل تنبيهات العلاقات؟",
  "nudges.consent.body":
    "سينظر Psyche في آخر مرة كتبتَ فيها إلى من تراسلهم أو سمعتَ منهم (التواريخ فقط، لا مضمون الكلام)، وأعياد الميلاد التي أكدتها، والوعود التي قطعتها بكلماتك.",
  "nudges.consent.rules":
    "لا يظهر أبدًا من استبعدتهم، ولا تُستخدم الحقائق الحساسة أبدًا، والتنبيه جملة بسيطة واحدة فيها اسم وعدد أيام. يمكنك كتم أي شخص بـ «ليس هذا الشخص»، وإيقاف هذا في أي وقت.",
  "nudges.consent.confirm": "تفعيل",
  "nudges.consent.cancel": "ليس الآن",
};
