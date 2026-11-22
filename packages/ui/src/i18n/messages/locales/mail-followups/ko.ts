import type { Catalogue } from "../../index.ts";

/** Follow-ups on quiet email threads (ko); merged into `../ko.ts`. */
export const mailFollowups: Partial<Catalogue> = {
  "home.quietThreads": "답이 없는 메일 대화",
  "home.quietThreads.hint": "내가 또는 상대방이 답하기를 기다리는 메일",
  "mailFollowups.someone": "상대방",
  "mailFollowups.line.noReply": "{who}님이 {days, plural, other {#일}}째 답하지 않았어요",
  "mailFollowups.line.question": "{who}님이 {days, plural, other {#일}} 전에 질문했어요",
  "mailFollowups.draft": "후속 메일 초안 쓰기",
  "mailFollowups.snooze": "나중에 알림",
  "mailFollowups.dismiss": "닫기",
  "mailFollowups.failed": "할 수 없었어요: {reason}",
  "mailFollowups.prefill": "이 대화의 후속 메일 초안을 써 주세요.",
  "mailFollowups.thread.title": "메일 후속 조치",
  "chat.composer.placeholderMail": "이 대화에 대해 질문하기",
  "daily.section.quiet_threads": "답이 없는 메일 대화",
};
