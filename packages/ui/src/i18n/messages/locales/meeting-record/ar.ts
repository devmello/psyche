import type { Catalogue } from "../../index.ts";

/** meeting-record strings (ar); merged into `../ar.ts`. */
export const meetingRecord: Partial<Catalogue> = {
  "meetingRecord.palette": "تسجيل اجتماع…",
  "meetingRecord.title": "تسجيل هذا الاجتماع؟",
  "meetingRecord.intro":
    "أخبر الجميع قبل أن تبدأ. قل هذا بصوت عالٍ أو الصقه في الدردشة. لا ينضم Psyche إلى مكالمة أبدًا ولا يسجّل إلا بعد أن تؤكد.",
  "meetingRecord.copy": "نسخ",
  "meetingRecord.copied": "تم النسخ",
  "meetingRecord.confirm": "أخبرتُ الجميع",
  "meetingRecord.cancel": "إلغاء",
  "meetingRecord.privacy":
    "يبقى الصوت في Psyche لديك، ويُحوَّل إلى ملاحظات هناك، ولا يُرفع إلى مكان آخر أبدًا ولا يُستخدم للتدريب.",
  "meetingRecord.unavailable":
    "يحتاج التسجيل إلى وسيلة لتحويل الصوت إلى ملاحظات (مساعد Mac)، وهي غير متصلة.",
  "meetingRecord.micDenied": "لا يستطيع Psyche استخدام الميكروفون. اسمح به في إعدادات النظام.",
  "meetingRecord.failed": "تعذّر على Psyche تسجيل هذا الاجتماع.",
  "meetingRecord.pill": "جارٍ تسجيل الاجتماع · {time}",
  "meetingRecord.stop": "إيقاف",
  "meetingRecord.stopping": "جارٍ الحفظ…",
  "meetingRecord.notes.processing": "جارٍ كتابة الملاحظات…",
  "meetingRecord.notes.done": "الملاحظات جاهزة في الرئيسية.",
  "meetingRecord.notes.needs_permission": "الملاحظات بانتظار موافقتك على استخدام نموذج سحابي.",
  "meetingRecord.notes.failed": "تعذّر على Psyche كتابة ملاحظات من هذا التسجيل.",
};
