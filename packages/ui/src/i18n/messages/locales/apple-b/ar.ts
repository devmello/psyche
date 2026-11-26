import type { Catalogue } from "../../index.ts";

/** Apple-design batch B (ar): plain approval cards and tool rows; merged into `../ar.ts`. */
export const appleB: Partial<Catalogue> = {
  "approvals.plain.run":
    "{who} يريد تشغيل `{command}`{hasFolder, select, true { في {folder}} other {}}.",
  "approvals.plain.save":
    "{who} يريد {mode, select, create {حفظ} other {تعديل}} {file}{hasFolder, select, true { في {folder}} other {}}.",
  "approvals.plainWhy.commands": "طلبت الموافقة على الأوامر قبل تشغيلها.",
  "approvals.plainWhy.yourRule": "وضعت قاعدة تقضي بالسؤال أولًا.",
  "approvals.plainWhy.noSandbox": "لم يتم إعداد البيئة المعزولة الآمنة بعد.",
  "approvals.plainWhy.protectedFiles": "هذه الملفات محمية، لذلك يسأل Psyche دائمًا.",
  "approvals.plainWhy.push": "نشر عملك يحتاج دائمًا إلى موافقتك.",
  "approvals.plainWhy.machineFiles": "تغيير الملفات على جهاز آخر يحتاج دائمًا إلى موافقتك.",
  "approvals.plainWhy.unknownTool": "هذه الأداة تأتي من موصّل لم توافق عليه بعد.",
  "approvals.plainWhy.connector": "يسأل هذا الموصّل قبل أن يتصرف.",
  "approvals.plainWhy.outsideNew": "قرأ Psyche شيئًا من الخارج، وهذا جديد عليه.",
  "approvals.plainWhy.outsideCommand":
    "قرأ Psyche شيئًا من الخارج، وقد يمتد هذا الأمر إلى ما وراء مجلده.",
  "blocks.toolRun.familyName":
    "{kind, select, command {أوامر} file {ملفات} web {الويب} mail {البريد} calendar {التقويم} drive {Drive} memory {الذاكرة} task {مهام} other {{name}}}",
  "blocks.toolRun.spoken":
    "{kind, select, command {شغّل أمرًا} write {حفظ ملفًا} edit {عدّل ملفًا} read {قرأ ملفًا} web {بحث في الويب} mail {استخدم البريد} calendar {استخدم التقويم} memory {استخدم الذاكرة} other {استخدم أداة}}",
  "blocks.toolRun.line.save": "حفظ {file}{hasFolder, select, true { في {folder}} other {}}",
  "approvals.plainWhy.outsideWorkspace": "هذا خارج المجلد الذي يعمل فيه Psyche.",
};
