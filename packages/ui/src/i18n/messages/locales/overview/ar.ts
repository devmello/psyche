import type { Catalogue } from "../../index.ts";

/** Overview screen strings (ar); merged into `../ar.ts`. */
export const overview: Partial<Catalogue> = {
  "overview.title": "{name} وأنت",
  "overview.screen": "نظرة عامة",
  "overview.period.label": "الفترة",
  "overview.period.week": "أسبوع",
  "overview.period.month": "شهر",
  "overview.period.all": "كل الوقت",
  "overview.range.since": "منذ {date}",
  "overview.range.allTime": "كل الوقت",
  "overview.jump.label": "انتقل إلى قسم",
  "overview.section.now": "الآن وما بعده",
  "overview.section.activity": "النشاط",
  "overview.section.growth": "النمو",
  "overview.section.people": "الأشخاص والمشاريع",
  "overview.section.built": "صُنع لك",
  "overview.section.specialists": "المتخصصون",
  "overview.section.upcoming": "القادم",
  "overview.section.recent": "التشغيلات الأخيرة",
  "overview.section.empty": "لا يوجد شيء هنا بعد.",
  "overview.loading": "جارٍ التحميل",
  "overview.error.load": "تعذّر التحميل",
  "overview.summary.label": "الملخص",
  "overview.summary.sentence.both":
    "{period, select, week {هذا الأسبوع} month {هذا الشهر} other {إجمالًا}}، أنجز {name} من أجلك {tasks, plural, zero {لا مهام ولا محادثات} one {مهمة أو محادثة واحدة} two {مهمتين أو محادثتين} few {# مهام ومحادثات} many {# مهمة ومحادثة} other {# مهمة ومحادثة}} وشغّل {automations, plural, zero {لا أتمتة} one {أتمتة واحدة} two {أتمتتين} few {# عمليات أتمتة} many {# أتمتة} other {# أتمتة}}.",
  "overview.summary.sentence.tasks":
    "{period, select, week {هذا الأسبوع} month {هذا الشهر} other {إجمالًا}}، أنجز {name} من أجلك {tasks, plural, zero {لا مهام ولا محادثات} one {مهمة أو محادثة واحدة} two {مهمتين أو محادثتين} few {# مهام ومحادثات} many {# مهمة ومحادثة} other {# مهمة ومحادثة}}.",
  "overview.summary.sentence.automations":
    "{period, select, week {هذا الأسبوع} month {هذا الشهر} other {إجمالًا}}، شغّل {name} من أجلك {automations, plural, zero {لا أتمتة} one {أتمتة واحدة} two {أتمتتين} few {# عمليات أتمتة} many {# أتمتة} other {# أتمتة}}.",
  "overview.summary.sentence.none":
    "{period, select, week {لم يُشغَّل شيء هذا الأسبوع.} month {لم يُشغَّل شيء هذا الشهر.} other {لم يُشغَّل شيء بعد.}}",
  "overview.summary.sentence.lessons":
    "تعلّم {name} منك {n, plural, zero {لا دروس} one {درسًا واحدًا} two {درسين} few {# دروس} many {# درسًا} other {# درس}}.",
  "overview.summary.quiet":
    "{period, select, week {لا شيء هذا الأسبوع.} month {لا شيء هذا الشهر.} other {لا شيء بعد.}}",
  "overview.summary.tile.tasks": "المهام المنجزة",
  "overview.summary.tile.automations": "الأتمتة المُشغَّلة",
  "overview.summary.tile.approvals": "الموافقات المحسومة",
  "overview.summary.tile.lessons": "الدروس المتعلَّمة",
  "overview.summary.vs.week": "الأسبوع الماضي",
  "overview.summary.vs.month": "الشهر الماضي",
  "overview.summary.runsOk": "{pct} من التشغيلات ناجحة",
  "overview.summary.failed": "{n} فشلت",
  "overview.summary.approved": "{n} موافَق عليها",
  "overview.summary.denied": "{n} مرفوضة",
  "overview.summary.expired": "{n} منتهية",
  "overview.summary.confirmed": "{n} مؤكَّدة",
  "overview.activity.meta":
    "{period, select, week {آخر 7 أيام} month {آخر 30 يومًا} other {كل الوقت}}",
  "overview.activity.label": "التشغيلات في اليوم",
  "overview.activity.series.tasks": "المهام",
  "overview.activity.series.automations": "الأتمتة",
  "overview.activity.series.chat": "المحادثات",
  "overview.activity.n.tasks":
    "{n, plural, zero {لا مهام} one {مهمة واحدة} two {مهمتان} few {# مهام} many {# مهمة} other {# مهمة}}",
  "overview.activity.n.automations":
    "{n, plural, zero {لا أتمتة} one {أتمتة واحدة} two {أتمتتان} few {# عمليات أتمتة} many {# أتمتة} other {# أتمتة}}",
  "overview.activity.n.chat":
    "{n, plural, zero {لا محادثات} one {محادثة واحدة} two {محادثتان} few {# محادثات} many {# محادثة} other {# محادثة}}",
  "overview.activity.dayTime": "{duration} من وقت التشغيل",
  "overview.activity.busiest":
    "أكثر الأيام نشاطًا: {date} · {n, plural, zero {لا عمليات تشغيل} one {تشغيل واحد} two {تشغيلان} few {# عمليات تشغيل} many {# عملية تشغيل} other {# عملية تشغيل}}",
  "overview.activity.worked": "عمل {name} لمدة {duration} (وقت التشغيل المقيس)",
  "overview.activity.topAutomation": "أكثر أتمتة تشغيلًا: {title} · {n}×",
  "overview.built.meta":
    "{count, plural, zero {لا عناصر} one {عنصر واحد} two {عنصران} few {# عناصر} many {# عنصرًا} other {# عنصر}}",
  "overview.built.seeAll": "عرض الكل",
  "overview.built.open": "فتح {title}",
  "overview.built.empty": "لم يُنشأ شيء في هذه الفترة بعد.",
  "overview.specialists.meta":
    "{count, plural, zero {لا نتائج} one {نتيجة واحدة} two {نتيجتان} few {# نتائج} many {# نتيجة} other {# نتيجة}}",
  "overview.specialists.empty": "لا توجد نتائج من المتخصصين في هذه الفترة.",
  "overview.newUser.title": "{name} يتعرّف عليك",
  "overview.newUser.body":
    "بعد أسبوع سترى ما فعله {name} من أجلك وما تعلّمه والأشخاص والمشاريع التي يتابعها.",
  "overview.newUser.try": "جرّب",
  "overview.newUser.planWeek": "اطلب من {name} تخطيط أسبوعك",
  "overview.newUser.morningBrief": "إعداد موجز صباحي",
  "overview.newUser.connectMail": "ربط بريدك",
  "overview.run.title": "تشغيل",
  "shell.rail.overview": "نظرة عامة",
  "shell.sidebar.openOverview": "فتح النظرة العامة",
  "overview.now.needsYou":
    "{n, plural, zero {لا شيء يحتاج إليك} one {شيء واحد يحتاج إليك} two {شيئان يحتاجان إليك} few {# أشياء تحتاج إليك} many {# شيئًا يحتاج إليك} other {# شيء يحتاج إليك}}",
  "overview.now.review": "مراجعة",
  "overview.now.running": "قيد التشغيل الآن",
  "overview.upcoming.today": "اليوم",
  "overview.upcoming.tomorrow": "غدًا",
  "overview.upcoming.week": "هذا الأسبوع",
  "overview.upcoming.later": "لاحقًا",
  "overview.upcoming.paused": "متوقفة مؤقتًا ({n, number})",
  "overview.recent.filterTasks": "المهام",
  "overview.recent.clearDay": "إزالة عامل التصفية {date}",
  "overview.recent.more": "عرض المزيد",
};
