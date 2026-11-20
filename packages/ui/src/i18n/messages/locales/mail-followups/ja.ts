import type { Catalogue } from "../../index.ts";

/** Follow-ups on quiet email threads (ja); merged into `../ja.ts`. */
export const mailFollowups: Partial<Catalogue> = {
  "home.quietThreads": "止まっているメールのやり取り",
  "home.quietThreads.hint": "あなたまたは相手からの返信を待っているメール",
  "mailFollowups.someone": "相手",
  "mailFollowups.line.noReply": "{who}から{days, plural, other {#日}}間、返信がありません",
  "mailFollowups.line.question": "{who}から質問されて{days, plural, other {#日}}たちました",
  "mailFollowups.draft": "フォローアップの下書きを作る",
  "mailFollowups.snooze": "後で通知",
  "mailFollowups.dismiss": "閉じる",
  "mailFollowups.failed": "実行できませんでした: {reason}",
  "mailFollowups.prefill": "このやり取りのフォローアップを下書きしてください。",
  "mailFollowups.thread.title": "メールのフォローアップ",
  "chat.composer.placeholderMail": "このやり取りについて質問",
  "daily.section.quiet_threads": "止まっているメールのやり取り",
};
