import type { Catalogue } from "../../index.ts";

/** Onboarding finish, recovery key and searchable switch (ar); merged into `../ar.ts`. */
export const simplifyB3: Partial<Catalogue> = {
  "onboarding.done.start": "ابدأ المحادثة",
  "onboarding.done.psycheLabel": "Psyche",
  "onboarding.done.psycheWait": "تعذّر الوصول إلى Psyche الآن. ستعيد هذه النافذة الاتصال تلقائيًا.",
  "onboarding.done.helperWait":
    "لم يتصل Psyche Helper بعد. سيبدأ التحكم بالكمبيوتر والإشعارات فور اتصاله.",
  "onboarding.connectors.searchable": "اجعل هذه قابلة للبحث",
  "onboarding.connectors.searchableHint":
    "يستطيع {name} العثور على البريد والأحداث والملاحظات من هذه الحسابات في البحث. يمكنك إيقاف أيٍّ منها من الإعدادات.",
  "home.recoveryKey.title": "احفظ مفتاح الاسترداد",
  "home.recoveryKey.body":
    "هو الطريقة الوحيدة للعودة إلى خزنتك بعد الاستعادة أو عند فقدان المفتاح. أظهره، واحتفظ بنسخة في مكان آمن، ثم أكّد.",
  "settings.credentials.vault.recoveryKey.show": "إظهار مفتاح الاسترداد",
  "settings.credentials.vault.recoveryKey.hide": "إخفاء",
  "settings.credentials.vault.recoveryKey.gone":
    "لم يُعرض مفتاح الاسترداد لهذه الخزنة إلا عند إنشائها، لذلك لا يمكن عرضه مرة أخرى.",
  "settings.credentials.vault.recoveryKey.failed": "تعذّر إظهار مفتاح الاسترداد: {reason}",
  "settings.credentials.vault.recoveryKey.title": "مفتاح الاسترداد",
  "settings.credentials.vault.recoveryKey.body":
    "الطريقة الوحيدة للعودة إلى الخزنة بعد الاستعادة أو عند فقدان المفتاح. احتفظ بنسخة في مكان آمن.",
};
