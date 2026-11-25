import type { Catalogue } from "../../index.ts";

/** Follow-ups on quiet email threads (zh); merged into `../zh.ts`. */
export const mailFollowups: Partial<Catalogue> = {
  "home.quietThreads": "沉寂的邮件往来",
  "home.quietThreads.hint": "正在等你或对方回复的邮件",
  "mailFollowups.someone": "对方",
  "mailFollowups.line.noReply": "{who}已经 {days, plural, other {#天}}没有回复",
  "mailFollowups.line.question": "{who}在 {days, plural, other {#天}}前问了你一个问题",
  "mailFollowups.draft": "起草跟进邮件",
  "mailFollowups.snooze": "稍后提醒",
  "mailFollowups.dismiss": "忽略",
  "mailFollowups.failed": "没能完成：{reason}",
  "mailFollowups.prefill": "请为这组邮件往来起草跟进邮件。",
  "mailFollowups.thread.title": "邮件跟进",
  "chat.composer.placeholderMail": "询问这组邮件往来",
  "daily.section.quiet_threads": "沉寂的邮件往来",
  "daily.section.night_shift": "夜班",
};
