import type { Catalogue } from "../../index.ts";

/** memoryPrivacy strings not covered elsewhere (ja); merged into `../ja.ts`. */
export const memoryPrivacyRest: Partial<Catalogue> = {
  "memoryPrivacy.title": "プライバシー",
  "memoryPrivacy.description": "{persona}が学習してよい相手、決して保持してはならないもの、忘れさせる方法を設定します。",
  "memoryPrivacy.forget": "忘れる",
  "memoryPrivacy.forgetHint": "1つの情報源から取り込んだ内容、または人物とプロジェクトに関するすべてを削除します。",
  "memoryPrivacy.sensitiveSummary": "{total, number}件中{n, number}件を許可",
  "memoryPrivacy.sensitiveChoose": "トピックを選択",
};
