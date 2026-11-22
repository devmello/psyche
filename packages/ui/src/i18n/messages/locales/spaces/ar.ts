import type { Catalogue } from "../../index.ts";

/** Spaces strings (ar); merged into `../ar.ts`. */
export const spaces: Partial<Catalogue> = {
  "spaces.title": "المساحات",
  "spaces.hint": "المشاريع التي تعود إليها دائمًا",
  "spaces.all": "كل المساحات",
  "spaces.new": "مساحة جديدة",
  "spaces.open": "فتح {name}",
  "spaces.private": "خاصة",
  "spaces.line.due":
    "{n, plural, zero {لا عناصر مستحقة} one {عنصر واحد مستحق} two {عنصران مستحقان} few {# عناصر مستحقة} many {# عنصرًا مستحقًا} other {# عنصر مستحق}}",
  "spaces.line.trackers":
    "{n, plural, zero {لا متتبعات} one {متتبع واحد} two {متتبعان} few {# متتبعات} many {# متتبعًا} other {# متتبع}}",
  "spaces.line.chats":
    "{n, plural, zero {لا محادثات} one {محادثة واحدة} two {محادثتان} few {# محادثات} many {# محادثة} other {# محادثة}}",
  "spaces.line.active": "نشطة {when}",
  "spaces.line.empty": "لا شيء هنا بعد",

  "spaces.list.title": "المساحات",
  "spaces.list.label": "مساحاتك",
  "spaces.list.empty":
    "لا مساحات بعد. تجمع المساحة محادثات المشروع وملفاته ومتتبعاته في مكان واحد.",
  "spaces.list.archived": "المؤرشفة",
  "spaces.list.moveUp": "نقل {name} لأعلى",
  "spaces.list.moveDown": "نقل {name} لأسفل",

  "spaces.create.title": "مساحة جديدة",
  "spaces.create.body": "تجمع المساحة محادثات المشروع وملفاته ومتتبعاته في مكان واحد.",
  "spaces.create.name": "الاسم",
  "spaces.create.namePlaceholder": "تجديد المطبخ",
  "spaces.create.description": "الغرض منها (اختياري)",
  "spaces.create.submit": "إنشاء المساحة",
  "spaces.create.failed": "لم تُنشأ المساحة: {reason}",

  "spaces.page.home": "الرئيسية",
  "spaces.page.newChat": "محادثة جديدة هنا",
  "spaces.page.more": "المزيد عن هذه المساحة",
  "spaces.page.notFound": "هذه المساحة لم تعد موجودة.",
  "spaces.page.loadFailed": "تعذّر تحميل هذه المساحة: {reason}",
  "spaces.page.archivedNote": "مؤرشفة. أتمتتها متوقفة ومجلداتها معطّلة.",
  "spaces.summary.instructions": "التعليمات",
  "spaces.summary.folders":
    "{n, plural, zero {لا مجلدات} one {مجلد واحد} two {مجلدان} few {# مجلدات} many {# مجلدًا} other {# مجلد}}",
  "spaces.summary.links":
    "{n, plural, zero {لا روابط} one {رابط واحد} two {رابطان} few {# روابط} many {# رابطًا} other {# رابط}}",

  "spaces.menu.instructions": "تعديل التعليمات",
  "spaces.menu.preview": "ما يراه Psyche هنا",
  "spaces.menu.keepPrivate": "إبقاؤها خاصة",
  "spaces.menu.showOnHome": "إظهارها في الرئيسية",
  "spaces.menu.archive": "أرشفة",
  "spaces.menu.restore": "استعادة",
  "spaces.menu.delete": "حذف",

  "spaces.instructions.title": "التعليمات",
  "spaces.instructions.body": "يتبعها Psyche في كل محادثة داخل هذه المساحة.",
  "spaces.instructions.label": "تعليمات {name}",
  "spaces.instructions.count": "{n} من {max}",
  "spaces.instructions.failed": "لم تُحفظ التعليمات: {reason}",

  "spaces.preview.title": "ما يراه Psyche هنا",
  "spaces.preview.body": "هذا ما تحصل عليه أي محادثة في هذه المساحة قبل رسالتك الأولى.",
  "spaces.preview.size": "{chars} من {cap} حرفًا",
  "spaces.preview.empty": "لا شيء بعد. أضف تعليمات لمنح Psyche السياق.",
  "spaces.preview.section.instructions": "التعليمات",
  "spaces.preview.section.card": "بطاقة المساحة",
  "spaces.preview.section.work": "أعمال مستحقة",
  "spaces.preview.section.trackers": "المتتبعات",

  "spaces.delete.title": "حذف {name}؟",
  "spaces.delete.body":
    "تبقى محادثاتها وأتمتتها بلا مساحة. تتوقف المجلدات عن العمل هنا. ولا يتأثر مشروع الذاكرة.",
  "spaces.delete.confirm": "حذف المساحة",

  "spaces.trackers": "المتتبعات",
  "spaces.trackers.add": "إضافة",
  "spaces.trackers.addLabel": "إضافة متتبع",
  "spaces.trackers.empty":
    "لا متتبعات بعد. أضف واحدًا من قالب، أو اختر «إضافة إلى مساحة» على أداة داخل محادثة.",
  "spaces.template.work_due": "أعمال مستحقة",
  "spaces.template.next_events": "الأحداث القادمة",
  "spaces.template.recent_files": "الملفات الأخيرة",
  "spaces.template.mail_on_this": "البريد المتعلق بهذا",
  "spaces.template.checklist": "قائمة مراجعة",
  "spaces.template.automation_status": "حالة الأتمتة",
  "spaces.tracker.refresh": "تحديث",
  "spaces.tracker.refreshLabel": "تحديث {title}",
  "spaces.tracker.remove": "إزالة {title} من هذه المساحة",
  "spaces.tracker.updated": "حُدّث {when}",
  "spaces.tracker.neverUpdated": "لم يُحدَّث بعد",
  "spaces.tracker.source": "من {source}",
  "spaces.tracker.addedByPsyche": "أضافه Psyche",
  "spaces.tracker.unavailable": "المصدر لم يعد موجودًا",

  "spaces.chats": "المحادثات",
  "spaces.chats.empty": "لا محادثات في هذه المساحة بعد.",
  "spaces.chats.moveIn": "نقل محادثة إلى هنا",
  "spaces.chats.moveNone": "كل المحادثات موجودة هنا بالفعل.",
  "spaces.chats.moveOut": "إخراج {title} من هذه المساحة",
  "spaces.chats.open": "فتح {title}",

  "spaces.automations": "الأتمتة",
  "spaces.automations.empty": "لا أتمتة في هذه المساحة.",

  "spaces.files": "الملفات والروابط",
  "spaces.files.empty": "لا مجلدات أو روابط بعد.",
  "spaces.files.ro": "للقراءة فقط",
  "spaces.files.rw": "قراءة وكتابة",
  "spaces.files.automationsRo": "الأتمتة للقراءة فقط",
  "spaces.files.addOnMac": "أضف المجلدات من الحاسوب الذي يعمل عليه Psyche",
  "spaces.goals": "الأهداف",

  "spaces.switcher.label": "المساحة: {name}",
  "spaces.switcher.none": "بلا مساحة",
  "spaces.switcher.noneMain": "بلا مساحة (المحادثات الرئيسية)",
  "spaces.switcher.new": "مساحة جديدة…",
  "spaces.switcher.move": "نقل هذه المحادثة إلى…",
  "spaces.switcher.moved": "نُقلت إلى {name}",
  "spaces.switcher.movedOut": "أُخرجت من {name}",
  "spaces.switcher.moveFailed": "لم تُنقل المحادثة: {reason}",

  "spaces.composer.chip": "في {name}",
  "spaces.composer.label": "هذه المحادثة في المساحة {name}",

  "spaces.add.label": "إضافة إلى مساحة…",
  "spaces.add.none": "لا مساحات بعد",
  "spaces.add.new": "مساحة جديدة…",
  "spaces.add.done": "أُضيف إلى {name}",
  "spaces.add.failed": "لم تتم الإضافة: {reason}",

  "spaces.palette.spaces": "المساحات",
  "spaces.palette.new": "مساحة جديدة",
  "spaces.palette.archived": "المساحات المؤرشفة",
  "spaces.palette.chatIn": "محادثة جديدة في {name}",
  "spaces.palette.keywords": "مساحة مشروع مساحة عمل متتبعات",
  "spaces.proposal.kicker": "مساحة مقترحة",
  "spaces.proposal.title": "هل تريد إنشاء مساحة لـ {name}؟",
  "spaces.proposal.untrusted":
    "اقتُرحت أثناء قراءة محتوى غير موثوق ({source}). النص أدناه مقتبس وليس من كلام Psyche.",
  "spaces.proposal.titleUntrusted": "هل تريد إنشاء هذه المساحة المقترحة؟",
  "spaces.proposal.project": "يربط المشروع {name}",
  "spaces.proposal.chats":
    "{n, plural, =0 {لا ينقل أي محادثة} one {ينقل محادثة واحدة:} two {ينقل محادثتين:} few {ينقل # محادثات:} many {ينقل # محادثة:} other {ينقل # محادثة:}}",
  "spaces.proposal.chatsLabel": "المحادثات التي سيتم نقلها",
  "spaces.proposal.untitledChat": "محادثة بلا عنوان",
  "spaces.proposal.create": "إنشاء",
  "spaces.proposal.notNow": "ليس الآن",
  "spaces.proposal.created": "تم إنشاء المساحة {name}",
  "spaces.proposal.open": "فتح",
  "spaces.proposal.failed": "لم تنجح العملية: {reason}",
  "spaces.migration.title": "هل تريد إنشاء مساحات لمشاريعك؟",
  "spaces.migration.hint":
    "ترتبط كل مساحة بمشروعها وتنقل محادثاته معها. تبقى الأدوات المثبّتة في الرئيسية.",
  "spaces.migration.line":
    "{threads, plural, zero {# محادثات} one {محادثة #} two {محادثتان} few {# محادثات} many {# محادثة} other {# محادثة}} · {folders, plural, zero {# مجلدات، مشتركة في كل مكان} one {مجلد #، مشترك في كل مكان} two {مجلدان، مشتركان في كل مكان} few {# مجلدات، مشتركة في كل مكان} many {# مجلدًا، مشتركة في كل مكان} other {# مجلد، مشتركة في كل مكان}}",
  "spaces.migration.create":
    "{n, plural, zero {إنشاء # مساحات} one {إنشاء مساحة #} two {إنشاء مساحتين} few {إنشاء # مساحات} many {إنشاء # مساحة} other {إنشاء # مساحة}}",
  "spaces.migration.created":
    "{n, plural, zero {تم إنشاء # مساحات} one {تم إنشاء مساحة #} two {تم إنشاء مساحتين} few {تم إنشاء # مساحات} many {تم إنشاء # مساحة} other {تم إنشاء # مساحة}}",
  "spaces.make": "إنشاء مساحة",
  "spaces.make.failed": "لم يتم إنشاء المساحة: {reason}",
  "spaces.openLinked": "فتح المساحة",
};
