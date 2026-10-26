import type { Catalogue } from "../../index.ts";

/** Overview Growth and People & projects strings (ar); merged into `../ar.ts`. */
export const overviewGrowth: Partial<Catalogue> = {
  "overview.meta.7d": "آخر 7 أيام",
  "overview.meta.30d": "آخر 30 يومًا",
  "overview.meta.all": "كل الوقت",
  "overview.growth.loading": "جارٍ تحميل التطور",
  "overview.growth.loadFailed": "تعذّر تحميل التطور",
  "overview.growth.empty": "لم يتم تعلّم أي شيء في هذه الفترة بعد.",
  "overview.growth.counts": "دروس هذه الفترة",
  "overview.growth.learned":
    "{n, plural, zero {لا دروس مُتعلَّمة} one {درس واحد مُتعلَّم} two {درسان مُتعلَّمان} few {# دروس مُتعلَّمة} many {# درسًا مُتعلَّمًا} other {# درس مُتعلَّم}}",
  "overview.growth.refined":
    "{n, plural, zero {لا شيء مُحسَّن} one {واحد مُحسَّن} two {اثنان مُحسَّنان} few {# مُحسَّنة} many {# مُحسَّنًا} other {# مُحسَّن}}",
  "overview.growth.confirmed":
    "{n, plural, zero {لا شيء مؤكَّد} one {واحد مؤكَّد} two {اثنان مؤكَّدان} few {# مؤكَّدة} many {# مؤكَّدًا} other {# مؤكَّد}}",
  "overview.growth.forgotten":
    "{n, plural, zero {لا شيء منسي} one {واحد منسي} two {اثنان منسيان} few {# منسية} many {# منسيًّا} other {# منسي}}",
  "overview.growth.milestones": "المعالم",
  "overview.growth.seeAll": "عرض كل الدروس",
  "overview.growth.sheetTitle": "ما تعلّمه {agent}",
  "overview.growth.evidenceTitle": "الأحداث وراء «{metric}»",
  "overview.growth.card.thisWeek": "دروس هذا الأسبوع ({n})",
  "overview.growth.card.week": "دروس أسبوع {date} ({n})",
  "overview.growth.card.review": "مراجعة",
  "overview.growth.card.sheetTitle": "ما تعلّمه {agent} هذا الأسبوع",
  "overview.growth.card.sheetDescription": "احتفظ بما التقطه {agent} أو عدّله أو انسَه.",
  "overview.people.loading": "جارٍ تحميل الأشخاص والمشاريع",
  "overview.people.loadFailed": "تعذّر تحميل الأشخاص والمشاريع",
  "overview.people.paused":
    "رسم الأشخاص والمشاريع متوقف مؤقتًا، لذا لا يُسجَّل شيء. فعّله من الإعدادات لتراه هنا.",
  "overview.people.empty":
    "لا أحد في هذه الفترة بعد. يظهر الأشخاص والمشاريع هنا عندما يعمل {agent} معهم نيابةً عنك.",
  "overview.people.map": "خريطة الأشخاص والمشاريع",
  "overview.people.mapHint":
    "تنقّل بين الأشخاص والمشاريع بمفاتيح الأسهم، الأكثر تفاعلًا أولًا. اضغط Enter لفتح أحدهم.",
  "overview.people.caption":
    "الأقرب إليك هو الأحدث. الأكبر هو الأكثر تفاعلًا. الدوائر أشخاص، والمربعات مشاريع ومؤسسات.",
  "overview.people.you": "أنت",
  "overview.people.ring.0": "هذا الأسبوع",
  "overview.people.ring.1": "هذا الشهر",
  "overview.people.ring.2": "قبل ذلك",
  "overview.people.kind.person": "شخص",
  "overview.people.kind.org": "مؤسسة",
  "overview.people.kind.project": "مشروع",
  "overview.people.kind.place": "مكان",
  "overview.people.interactions":
    "{n, plural, zero {لا تفاعلات} one {تفاعل واحد} two {تفاعلان} few {# تفاعلات} many {# تفاعلًا} other {# تفاعل}}",
  "overview.people.openLoops":
    "{n, plural, zero {لا بنود مفتوحة} one {بند مفتوح واحد} two {بندان مفتوحان} few {# بنود مفتوحة} many {# بندًا مفتوحًا} other {# بند مفتوح}}",
  "overview.people.last": "آخر تفاعل {when}",
  "overview.people.node": "{name}، {kind}. {interactions}. آخر تفاعل {when}. {loops}.",
  "overview.people.detailHint": "مرّر المؤشر أو ركّز على شخص أو مشروع لعرض تفاصيله.",
  "overview.people.counts":
    "{people, plural, zero {لا أشخاص} one {شخص واحد} two {شخصان} few {# أشخاص} many {# شخصًا} other {# شخص}} · {projects, plural, zero {لا مشاريع} one {مشروع واحد} two {مشروعان} few {# مشاريع} many {# مشروعًا} other {# مشروع}} · {loops, plural, zero {لا بنود مفتوحة} one {بند مفتوح واحد} two {بندان مفتوحان} few {# بنود مفتوحة} many {# بندًا مفتوحًا} other {# بند مفتوح}}",
  "overview.people.ranked": "{name} {n}",
  "overview.people.showList": "عرض كقائمة",
  "overview.people.showMap": "عرض الخريطة",
  "overview.people.seeAll": "عرض الكل",
  "overview.people.list": "الأشخاص والمشاريع، الأكثر تفاعلًا أولًا",
  "overview.people.table.name": "الاسم",
  "overview.people.table.kind": "النوع",
  "overview.people.table.interactions": "التفاعلات",
  "overview.people.table.last": "آخر تفاعل",
  "overview.people.table.loops": "البنود المفتوحة",
};
