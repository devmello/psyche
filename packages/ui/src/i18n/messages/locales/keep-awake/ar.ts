import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (ar); merged into `../ar.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "إبقاء هذا الجهاز مستيقظًا",
  "settings.daily.keepAwake.hint":
    "أثناء تشغيل مهمة مجدولة، لن ينام هذا الجهاز حتى تنتهي. يمكن أن تنطفئ الشاشة.",
  "settings.key.scheduled.keepAwake": "إبقاء هذا الجهاز مستيقظًا أثناء تشغيل المهام المجدولة",
  "scheduled.history.retryingAt": "إعادة المحاولة عند {time}",
  "scheduled.history.retry": "المحاولة {n} من 3",
  "scheduled.history.failedAfterRetries": "فشل بعد {n} من إعادات المحاولة",
};
