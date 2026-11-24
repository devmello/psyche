import type { Catalogue } from "../../index.ts";

/** Approval-friction and person-interaction strings (ar); merged into `../ar.ts`. */
export const friction: Partial<Catalogue> = {
  "friction.title": "إزعاج طلبات الإذن",
  "friction.hint":
    "عدد المرات التي يتوقف فيها Psyche ليسأل قبل أن يتصرف، وكيف تجيب. أرقام فقط من سجل التدقيق.",
  "friction.window": "الفترة الزمنية",
  "friction.window.days": "آخر {days} يومًا",
  "friction.loading": "جارٍ إحصاء طلبات الإذن…",
  "friction.error": "تعذّر تحميل إزعاج طلبات الإذن: {reason}",
  "friction.retry": "أعد المحاولة",
  "friction.empty": "لم يفحص Psyche أي إجراء في هذه الفترة، لذلك لا يوجد ما يُعرض.",
  "friction.since": "منذ {date}",
  "friction.asked":
    "سأل عن {asks, plural, one {إجراء واحد} other {# إجراءً}} من أصل {decisions, plural, one {إجراء واحد} other {# إجراءً}} تم فحصها ({rate}%).",
  "friction.perRun": "متوسط عدد الأسئلة في كل تشغيل سأل مرة واحدة على الأقل: {n}.",
  "friction.answered": "من الأسئلة التي انتهت، أُجيب على {rate}% قبل انتهاء صلاحيتها.",
  "friction.approved": "من الأسئلة التي انتهت، وافقت على {rate}%.",
  "friction.noTimes": "لم يُجَب على أي سؤال في هذه الفترة، لذلك لا يوجد زمن إجابة.",
  "friction.times": "استغرقت الإجابة وسيطًا قدره {p50}. استغرقت العُشر الأبطأ {p90} أو أكثر.",
  "friction.expired":
    "{n, plural, =0 {لم تنتهِ صلاحية أي سؤال دون إجابة.} one {انتهت صلاحية سؤال واحد دون إجابة.} other {انتهت صلاحية # سؤالًا دون إجابة.}}",
  "friction.rejected":
    "{n, plural, =0 {لم تُرفض أي إجابة.} one {رُفضت إجابة واحدة لكونها غير صالحة.} other {رُفضت # إجابة لكونها غير صالحة.}}",
  "friction.saved":
    "{n, plural, =0 {لم يمر أي إجراء عبر إذن دائم دون بطاقة.} one {مرّ إجراء واحد عبر إذن دائم دون بطاقة.} other {مرّ # إجراءً عبر إذن دائم دون بطاقة.}}",
  "friction.grantsCreated":
    "{n, plural, =0 {لم يُنشأ أي إذن دائم.} one {أُنشئ إذن دائم واحد.} other {أُنشئ # إذنًا دائمًا.}}",
  "friction.kinds": "مصدر الأسئلة",
  "friction.kind.row": "{kind}: سُئل {asks}، وُوفق {approved}، رُفض {declined}، انتهى {expired}",
  "friction.rules": "أكثر أسباب السؤال شيوعًا",
  "friction.rule.row": "{label}: {count}",
  "friction.rule.mode": "إعداد وضعك",
  "friction.rule.taint": "محتوى من خارج الجهاز",
  "friction.rule.policy": "سياستك",
  "friction.rule.designated": "مكان محمي",
  "friction.rule.site": "قاعدة موقع",
  "friction.rule.other": "قاعدة أخرى",
  "friction.modes": "حسب الوضع",
  "friction.mode.row": "{mode}: سأل {asks} من {decisions}",

  "people.interactions.title": "التفاعلات الأخيرة",
  "people.interactions.empty": "لا توجد تفاعلات مع {name} بعد.",
  "people.interactions.error": "تعذّر تحميل التفاعلات: {reason}",
  "people.interactions.more": "عرض المزيد",
  "people.interactions.loadingMore": "جارٍ التحميل…",
};
