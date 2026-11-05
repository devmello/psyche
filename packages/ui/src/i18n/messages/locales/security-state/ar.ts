import type { Catalogue } from "../../index.ts";

/** The security-records banner and review panel (ar); merged into `../ar.ts`. */
export const securityState: Partial<Catalogue> = {
  "web.security.banner.changed": "تراجع Psyche عن تغيير في سجلات الأمان أُجري خارج التطبيق.",
  "web.security.banner.untrusted":
    "فشل فحص سجلات الأمان في Psyche. التغييرات التي توسّع الوصول محظورة.",
  "web.security.banner.recovery":
    "{count, plural, one {تغيير أمان طُلب على هذا الـ Mac سيُطبَّق في {when} ما لم تلغه.} two {تغييرا أمان طُلبا على هذا الـ Mac ينتظران. التالي يُطبَّق في {when}.} few {# تغييرات أمان طُلبت على هذا الـ Mac تنتظر. التالي يُطبَّق في {when}.} many {# تغيير أمان طُلب على هذا الـ Mac ينتظر. التالي يُطبَّق في {when}.} other {# تغيير أمان طُلب على هذا الـ Mac ينتظر. التالي يُطبَّق في {when}.}}",
  "web.security.banner.notice":
    "{count, plural, one {إشعار أمان واحد للمراجعة.} two {إشعارا أمان للمراجعة.} few {# إشعارات أمان للمراجعة.} many {# إشعار أمان للمراجعة.} other {# إشعار أمان للمراجعة.}}",
  "web.security.review": "مراجعة",
  "web.security.hide": "إخفاء",
  "web.security.panel.label": "سجلات الأمان",
  "web.security.alert.changed":
    "غيّر برنامج على هذا الـ Mac {count, plural, one {سجل أمان واحدًا} two {سجلَّي أمان} few {# سجلات أمان} many {# سجل أمان} other {# سجل أمان}} دون المرور عبر Psyche. أعاد Psyche ما تغيّر كما كان. إن لم تكن أنت من فعل ذلك، فافحص الـ Mac بحثًا عن برامج غير مرغوب فيها.",
  "web.security.alert.untrusted":
    "فشل فحص سجلات الأمان في Psyche. الأجهزة الجديدة وإعدادات الأمان والموافقات بـ Touch ID محظورة. راجع أجهزتك ثم شغّل psyched security reseal على الـ Mac؛ يُطبَّق ذلك بعد 24 ساعة.",
  "web.security.alert.firstSeal":
    "أصبح Psyche يفحص سجلات الأمان ({devices, plural, zero {لا أجهزة مقترنة} one {جهاز مقترن واحد} two {جهازان مقترنان} few {# أجهزة مقترنة} many {# جهازًا مقترنًا} other {# جهاز مقترن}}). أي تغيير يُجرى خارج Psyche يُتراجع عنه ويظهر هنا. راجع أجهزتك مرة واحدة.",
  "web.security.alert.resealed": "ختم Psyche سجلات الأمان من جديد.",
  "web.security.alert.restored":
    "بدأ Psyche من نسخة احتياطية مستعادة وختم سجلات الأمان كما هي. إن لم تستعد نسخة احتياطية، فراجع أجهزتك.",
  "web.security.alert.firstAdmin":
    "جعل أمر على هذا الـ Mac الجهاز {name} أول جهاز مسؤول. إن لم تكن أنت، فألغِه من الأجهزة.",
  "web.security.alert.requested": "طُلب على هذا الـ Mac: {action} يُطبَّق في {when}.",
  "web.security.alert.applied": "طُبِّق: {action}",
  "web.security.alert.cancelled": "أُلغي: {action}",
  "web.security.alert.failed": "تعذّر التطبيق: {action}",
  "web.security.op.devicesApprove": "الموافقة على الجهاز {name}.",
  "web.security.op.devicesGrant": "تغيير ما يمكن أن يفعله {name}.",
  "web.security.op.presenceReset":
    "التوقف عن طلب Touch ID أو مفتاح المرور لتغييرات الأمان حتى يُسجَّل مفتاح جديد.",
  "web.security.op.sealReset": "قبول سجلات الأمان الحالية كما هي.",
  "web.security.device": "جهاز",
  "web.security.change": "{change, select, added {أُضيف} modified {تغيّر} other {أُزيل}}: {what}",
  "web.security.more":
    "{count, plural, one {وواحد آخر} two {واثنان آخران} few {و# أخرى} many {و# أخرى} other {و# أخرى}}",
  "web.security.ack": "وضع علامة تمت المراجعة",
  "web.security.approveNow": "الموافقة الآن",
  "web.security.cancel": "إلغاء الطلب",
  "web.security.needsApproval":
    "وافق على البطاقة بـ Touch ID أو مفتاح مرور، ثم اضغط الزر مرة أخرى.",
  "web.security.failed": "لم ينجح ذلك: {message}",
};
