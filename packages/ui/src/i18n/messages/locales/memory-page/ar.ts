import type { Catalogue } from "../../index.ts";

/** memory-page strings (ar); merged into `../ar.ts`. */
export const memoryPage: Partial<Catalogue> = {
  "memory.page.title": "الذاكرة",
  "memory.page.soul": "Soul",
  "memory.page.kinds": "ما يُعرض",
  "memory.page.kind.everything": "كل شيء",
  "memory.page.kind.people": "الأشخاص",
  "memory.page.kind.projects": "المشاريع",
  "memory.page.kind.due": "أعمال مستحقة",
  "memory.page.kind.events": "الأحداث",
  "memory.page.kind.more": "المزيد",
  "memory.page.review": "المراجعة",
  "memory.page.reviewWaiting": "المراجعة، {n} بانتظارك",
  "memory.page.back": "العودة إلى {tab}",
  "memory.page.continue": "المتابعة في الدردشة",
  "memory.page.continue.prefillWork": "أين وصلت في هذا؟",
  "memory.page.continue.prefill": "أطلعني على آخر مستجدات هذا.",
  "memory.page.continue.threadTitle": "متابعة من الذاكرة",
  "memory.page.continue.source": "الذاكرة",
  "memory.page.continue.failed": "تعذّر فتح الدردشة. {reason}",
  "memory.page.seeAll": "عرض الكل",
  "memory.page.loadFailed": "تعذّر تحميل هذا الجزء من الذاكرة.",
  "memory.page.everything.empty":
    "لم يُتذكَّر شيء بعد. فعّل مصدرًا في الإعدادات ← الذاكرة، أو أخبر {persona} في الدردشة.",
  "memory.page.everything.review": "للمراجعة",
  "memory.page.everything.reviewCount":
    "{n, plural, zero {لا حقائق بانتظار موافقتك} one {حقيقة واحدة بانتظار موافقتك} two {حقيقتان بانتظار موافقتك} few {# حقائق بانتظار موافقتك} many {# حقيقة بانتظار موافقتك} other {# حقيقة بانتظار موافقتك}}",
  "memory.page.everything.due": "مستحقة قريبًا",
  "memory.page.everything.projects": "المشاريع النشطة",
  "memory.page.everything.people": "الأشخاص الذين تتواصل معهم",
  "memory.page.everything.events": "قريبًا",
  "memory.page.projects.filter": "الحالة",
  "memory.page.projects.empty": "لا مشاريع هنا بعد.",
  "memory.page.projects.nothing": "لا مشاريع تطابق «{query}».",
  "memory.page.due.title": "لا شيء مستحق",
  "memory.page.due.body":
    "ستظهر الفواتير والتجديدات ومواعيد العمل والواجبات هنا عندما يتتبعها {persona}.",
  "memory.page.events.upcoming": "القادمة",
  "memory.page.events.other": "أحداث أخرى",
  "memory.page.events.empty":
    "لا مواعيد قادمة. تظهر هنا أعياد الميلاد والذكريات السنوية والأحداث التي تؤكدها.",
  "memory.page.events.when":
    "{n, plural, zero {اليوم} one {غدًا} two {بعد يومين} few {بعد # أيام} many {بعد # يومًا} other {بعد # يوم}}",
  "memory.page.more.place": "الأماكن",
  "memory.page.more.org": "المنظمات",
  "memory.page.more.topic": "المواضيع",
  "memory.page.more.empty": "لا أماكن ولا منظمات ولا مواضيع بعد.",
};
