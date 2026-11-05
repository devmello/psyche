import type { Catalogue } from "../../index.ts";

/** automation-chat strings (ar); merged into `../ar.ts`. */
export const automationChat: Partial<Catalogue> = {
  "automationChat.label": "تشغيلات {title}",
  "automationChat.runs":
    "{n, plural, zero {لا تشغيلات} one {تشغيل واحد} two {تشغيلان} few {# تشغيلات} many {# تشغيلًا} other {# تشغيل}}",
  "automationChat.runs.aria":
    "{title}، {n, plural, zero {لا تشغيلات} one {تشغيل واحد} two {تشغيلان} few {# تشغيلات} many {# تشغيلًا} other {# تشغيل}}، آخر تشغيل {status}",
  "automationChat.schedule": "المجدولة",
  "automationChat.runNow": "التشغيل الآن",
  "automationChat.empty": "لا تشغيلات بعد. في كل مرة تعمل هذه الأتمتة تظهر هنا.",
  "automationChat.loading": "جارٍ تحميل التشغيلات",
  "automationChat.failed": "تعذّر على Psyche تحميل التشغيلات",
  "automationChat.more": "عرض التشغيلات الأقدم",
  "automationChat.status.needsYou": "بحاجة إليك",
  "automationChat.status.running": "قيد التشغيل",
  "automationChat.trigger.manual": "التشغيل الآن",
  "automationChat.trigger.event": "عند حدوث حدث",
  "automationChat.coalesced": "{n} تشغيلات فائتة في تشغيل واحد",
  "automationChat.noResult": "لم تُكتب نتيجة",
  "automationChat.noSteps": "لم تُسجَّل خطوات لهذا التشغيل.",
  "automationChat.stepsLoading": "جارٍ تحميل الخطوات",
  "automationChat.timeline": "فتح في الجدول الزمني",
  "automationChat.approvals": "فتح الموافقات",
  "automationChat.waiting": "هذا التشغيل بانتظارك.",
  "automationChat.result": "النتيجة",
  "automationChat.openScheduled": "فتح في المجدولة",
  "automationChat.row.runs":
    "{n, plural, zero {لا تشغيلات} one {تشغيل واحد} two {تشغيلان} few {# تشغيلات} many {# تشغيلًا} other {# تشغيل}}",
  "automationChat.row.last": "آخر تشغيل: {status}",
};
