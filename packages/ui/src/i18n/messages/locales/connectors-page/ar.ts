import type { Catalogue } from "../../index.ts";

/** connectors-page strings (ar); merged into `../ar.ts`. */
export const connectorsPage: Partial<Catalogue> = {
  "settings.connectors.page.description":
    "التطبيقات والأدوات التي يستطيع {persona} استخدامها. يسأل كل منها قبل أن يتصرف، ما لم تقل غير ذلك.",
  "settings.connectors.page.needsYou": "بحاجة إليك",
  "settings.connectors.page.connected": "متصل",
  "settings.connectors.page.onThisMac": "على هذا الـ Mac",
  "settings.connectors.page.addMore": "إضافة المزيد",
  "settings.connectors.page.addMore.hint":
    "البريد والتقويم والملاحظات وأدوات جاهزة. يسأل كل منها قبل أن يتصرف.",
  "settings.connectors.page.addMore.browse": "تصفّح الكل",
  "settings.connectors.page.status.paused": "متوقف مؤقتًا",
  "settings.connectors.page.status.notWorking": "لا يعمل",
  "settings.connectors.page.status.signInExpired": "انتهت صلاحية تسجيل الدخول",
  "settings.connectors.page.status.on": "مفعّل",
  "settings.connectors.page.status.off": "متوقف",
  "settings.connectors.page.paused": "متوقف مؤقتًا",
  "settings.connectors.page.open": "فتح {name}",
  "settings.connectors.page.manage": "إدارة",
  "settings.connectors.page.fix.seeWhy": "لماذا؟",
  "settings.connectors.page.row.never": "لم يُستخدم بعد",
  "settings.connectors.page.row.lastUsed": "استُخدم {when}",
  "settings.connectors.page.row.unverified": "غير موثّق",
  "settings.connectors.page.row.local": "يعمل على هذا الـ Mac",
  "settings.connectors.page.row.remote": "يتصل عبر الويب",
  "settings.connectors.page.row.files":
    "{count, plural, zero {لا مجلدات مشاركة} one {مجلد واحد مشارك} two {مجلدان مشاركان} few {# مجلدات مشاركة} many {# مجلدًا مشاركًا} other {# مجلد مشارك}}",
  "settings.connectors.page.row.terminal.on": "يستطيع تشغيل الأوامر",
  "settings.connectors.page.row.terminal.off": "الأوامر متوقفة",
  "settings.connectors.page.detail.label": "تفاصيل {name}",
  "settings.connectors.page.detail.about": "حول",
  "settings.connectors.page.detail.access": "الوصول",
  "settings.connectors.page.detail.source": "المصدر",
  "settings.connectors.page.detail.technical": "تفاصيل تقنية",
  "settings.connectors.page.detail.manage": "إيقاف مؤقت أو إزالة",
  "settings.connectors.page.detail.type": "النوع",
  "settings.connectors.page.detail.removeHint":
    "«قطع الاتصال» يوقفه مؤقتًا ويُبقي إعداداته. «الإزالة» تحذفه.",
  "settings.connectors.page.source.builtIn": "مضمَّن في Psyche",
  "settings.connectors.page.source.verified": "ناشر موثّق",
  "settings.connectors.page.source.unverified": "لم يفحصه أحد بعد",
  "settings.connectors.page.attention.signIn":
    "انتهت صلاحية تسجيل دخولك إلى {name}. سجّل الدخول مجددًا ليواصل العمل.",
  "settings.connectors.page.attention.error":
    "{name} لا يعمل حاليًا. جرّب تسجيل الدخول مجددًا؛ وإن استمر الفشل فأزله وأضفه من جديد.",
  "settings.connectors.page.attention.errorReason": "ما قاله: {reason}",
  "settings.connectors.page.attention.server": "لم يبدأ {name}، لذا أدواته غير متاحة.",
  "settings.connectors.page.attention.serverHint":
    "تحقق من أمره أو عنوانه وأي أسرار أدناه، ثم أوقفه وشغّله مجددًا.",
  "settings.connectors.page.server.local": "أداة تعمل في بيئة معزولة على هذا الـ Mac",
  "settings.connectors.page.server.remote": "أداة تصل إليها بعنوان ويب",
  "settings.connectors.page.server.network": "يصل إلى الشبكة",
  "settings.connectors.page.server.noNetwork": "بلا شبكة",
  "settings.connectors.page.advanced": "متقدم",
  "settings.connectors.page.advanced.hint": "خوادم الأدوات الخاصة بك، وبحث في السجل العام.",
  "settings.connectors.page.advanced.custom": "خادم أدوات خاص بك",
  "settings.connectors.page.advanced.customHint":
    "شغّل أي خادم MCP في البيئة المعزولة، أو اتصل بواحد بعنوان ويب.",
  "settings.connectors.page.advanced.customAction": "إضافة خادم",
  "settings.connectors.page.advanced.find": "البحث عن خوادم على الإنترنت",
  "settings.connectors.page.gallery.title": "إضافة موصّل",
  "settings.connectors.page.gallery.intro":
    "اختر شيئًا لتجربته. كل واحد يسأل قبل أن يفعل أي شيء، ويمكنك إزالته في أي وقت.",
  "settings.connectors.page.gallery.noMatch": "لا شيء مطابق. جرّب كلمة أخرى.",
  "settings.connectors.page.gallery.back": "العودة إلى المعرض",
  "settings.connectors.page.gallery.community": "المجتمع",
};
