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
  "overview.run.placeholder": "يُنقل الجدول الزمني للتشغيل إلى هنا.",
  "overview.run.back": "العودة إلى النظرة العامة",
  "shell.rail.overview": "نظرة عامة",
  "shell.sidebar.openOverview": "فتح النظرة العامة",
};
