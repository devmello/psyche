import type { Catalogue } from "../../index.ts";

/** home strings (ar); merged into `../ar.ts`. */
export const home: Partial<Catalogue> = {
  "home.title": "الرئيسية",
  "home.needsYou": "بحاجة إليك",
  "home.needsYou.count":
    "{n, plural, zero {لا شيء ينتظر} one {واحد ينتظر} two {اثنان ينتظران} few {# تنتظر} many {# ينتظر} other {# ينتظر}}",
  "home.needsYou.all": "كل الإشعارات",
  "home.today": "اليوم",
  "home.today.hint": "موجزك، يُكتب كل صباح",
  "home.today.posts":
    "{n, plural, zero {لا منشورات} one {منشور واحد} two {منشوران} few {# منشورات} many {# منشورًا} other {# منشور}}",
  "home.suggestions": "الاقتراحات",
  "home.suggestions.hint": "أفكار وأهداف لتقول نعم أو لا",
  "home.suggestions.count":
    "{n, plural, zero {لا جديد} one {واحد جديد} two {اثنان جديدان} few {# جديدة} many {# جديدًا} other {# جديد}}",
  "home.comingUp": "قريبًا",
  "home.comingUp.hint": "التشغيلات القادمة لأتمتتك وروتينك",
  "home.comingUp.all": "المجدولة",
  "home.comingUp.line": "{schedule} · {next}",
  "home.comingUp.open": "فتح {title} في المجدولة",
  "home.comingUp.more":
    "{n, plural, zero {} one {واحد آخر في المجدولة} two {اثنان آخران في المجدولة} few {# أخرى في المجدولة} many {# آخر في المجدولة} other {# آخر في المجدولة}}",
  "home.goals": "الأهداف",
  "home.goals.hint": "ما تعمل من أجله",
  "home.goals.all": "كل الأهداف",
  "home.keepInTouch": "ابقَ على تواصل",
  "home.keepInTouch.hint": "أشخاص قد ينتظرون أن تتواصل معهم",
  "home.keepInTouch.people": "الأشخاص",
  "home.ask.label": "اسأل {name} أي شيء",
  "home.ask.send": "إرسال",
  "home.ask.failed": "لم يُرسل ذلك: {reason}",
  "home.start.try": "جرّب",
  "home.start.planWeek": "خطّط لأسبوعي",
  "home.start.planWeek.prompt":
    "ساعدني في التخطيط لهذا الأسبوع. اطّلع على ما هو قادم واسألني عمّا يهمني أكثر.",
  "home.start.brief": "إعداد موجز صباحي",
  "home.start.brief.prompt": "أعدّ لي موجزًا صباحيًا قصيرًا في أيام العمل. اسألني عمّا ينبغي أن يغطيه.",
  "home.start.remember": "أخبر {name} عنك",
  "home.start.remember.prompt":
    "تعرّف عليّ: اسألني بضعة أسئلة عن عملي وما أريد المساعدة فيه، وتذكّر الإجابات.",
  "home.showMore":
    "{n, plural, zero {} one {عرض واحد آخر} two {عرض اثنين آخرين} few {عرض # آخرين} many {عرض # آخر} other {عرض # آخر}}",
  "home.showLess": "عرض أقل",
  "home.catchUp": "اللحاق بالمستجدات",
  "home.catchUp.hint": "ما المستحق وما تحرّك منذ آخر مرة نظرت فيها",
  "home.catchUp.open": "فتح {title}",
  "home.catchUp.source": "من {source}",
  "home.catchUp.all": "كل الأعمال المستحقة",
  "home.catchUp.pending":
    "{n, plural, zero {} one {عنصر جديد واحد للتأكيد} two {عنصران جديدان للتأكيد} few {# عناصر جديدة للتأكيد} many {# عنصرًا جديدًا للتأكيد} other {# عنصر جديد للتأكيد}}",
  "home.ask.list": "الأسئلة المتأخرة",
  "home.ask.handedInLabel": "وضع علامة «تم التسليم» على «{title}»",
  "home.ask.stillWorking": "ما زال قيد العمل",
  "home.ask.stillWorkingLabel": "ما زلت أعمل على «{title}»",
  "home.more": "المزيد",
  "home.more.brief": "إعدادات الموجز",
  "home.more.memoryReview": "مراجعة الذاكرة",
  "home.more.briefHint": "ما يغطيه الموجز اليومي ومتى يصل",
  "home.more.overview": "النشاط والنمو والجدول الزمني لكل تشغيل",
  "home.more.scheduled": "الأتمتة والروتين وسجل التشغيل",
  "home.more.inbox": "كل إشعار، أُجيب عنه أم لا",
  "home.more.soul": "ما يتذكره {name}، وملفاته الخاصة",
  "home.more.review": "حقائق ومتابعات بانتظار موافقتك",
  "home.loadFailed": "تعذّر تحميل {what}.",
  "people.page.title": "الأشخاص",
  "people.page.count":
    "{n, plural, zero {لا أحد} one {شخص واحد} two {شخصان} few {# أشخاص} many {# شخصًا} other {# شخص}}",
  "people.page.memory": "Soul والذاكرة",
  "people.page.openPeople": "الأشخاص والمشاريع",
  "people.page.openPeopleHint": "انتقل إلى صفحته الخاصة",
};
