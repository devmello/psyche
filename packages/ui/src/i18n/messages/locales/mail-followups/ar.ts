import type { Catalogue } from "../../index.ts";

/** Follow-ups on quiet email threads (ar); merged into `../ar.ts`. */
export const mailFollowups: Partial<Catalogue> = {
  "home.quietThreads": "محادثات بريد متوقفة",
  "home.quietThreads.hint": "رسائل بريد تنتظر ردًّا، منك أو من الطرف الآخر",
  "mailFollowups.someone": "شخص ما",
  "mailFollowups.line.noReply":
    "لم يرد {who} منذ {days, plural, zero {# يوم} one {يوم واحد} two {يومين} few {# أيام} many {# يومًا} other {# يوم}}",
  "mailFollowups.line.question":
    "سألك {who} سؤالًا منذ {days, plural, zero {# يوم} one {يوم واحد} two {يومين} few {# أيام} many {# يومًا} other {# يوم}}",
  "mailFollowups.draft": "صياغة رسالة متابعة",
  "mailFollowups.snooze": "تأجيل",
  "mailFollowups.dismiss": "تجاهل",
  "mailFollowups.failed": "تعذّر ذلك: {reason}",
  "mailFollowups.prefill": "اكتب مسودة متابعة لهذه المحادثة.",
  "mailFollowups.thread.title": "متابعة بريد",
  "chat.composer.placeholderMail": "اسأل عن هذه المحادثة",
  "daily.section.quiet_threads": "محادثات بريد متوقفة",
  "daily.section.promises": "الوعود",
  "screens.inbox.kind.promise_due": "وعد مستحق",
  "daily.section.night_shift": "الوردية الليلية",
};
