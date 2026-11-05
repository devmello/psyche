import type { Catalogue } from "../../index.ts";

/** agent-notes strings (ar); merged into `../ar.ts`. */
export const agentNotes: Partial<Catalogue> = {
  "agent.notes.title": "ما دوّنه {name}",
  "agent.notes.hint":
    "أشياء حفظها {name} لاستخدامه لاحقًا: ما نجح، وخصوصيات الأدوات، وكيف تحب أن تُنجَز الأمور. احذف ما لا تريد الاحتفاظ به.",
  "agent.notes.empty": "لم يُدوَّن شيء بعد.",
  "agent.notes.updated": "حُدّثت في {date}",
  "agent.notes.delete": "حذف الملاحظة {file}",
  "agent.notes.deleteTitle": "حذف هذه الملاحظة؟",
  "agent.notes.deleteBody": "يُزال {file} من ذاكرة {name}. لا يمكن التراجع عن ذلك.",
  "agent.notes.source.agent": "دوّنه الوكيل",
  "agent.notes.source.untrusted": "من محتوى غير موثوق، لا يُستخدم أبدًا",
  "agent.notes.source.owner": "عدّلتَه أنت",
  "agent.notes.source.system": "النظام",
};
