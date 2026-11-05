import type { Catalogue } from "../../index.ts";

/** personData strings not covered elsewhere (ja); merged into `../ja.ts`. */
export const personDataRest: Partial<Catalogue> = {
  "personData.export": "すべて書き出し…",
  "personData.said": "言ったことを忘れる…",
  "personData.exclude": "この人について学習しない…",
  "personData.excludeForget": "この人について学習せず、忘れる…",
  "personData.title.said": "{name}が言ったことを忘れますか？",
  "personData.title.exclude": "{name}についての学習を停止しますか？",
  "personData.title.exclude_forget": "{name}についての学習を停止して忘れますか？",
  "personData.counts": "その人のメッセージから学んだ事実{facts, number}件、引用{quotes, number}件、保留中の項目{held, number}件を削除します。",
  "personData.excludeOnly": "その人のメッセージは読み取られず、その人について何も学習されません。すでにわかっていることは、忘れさせるまで残ります。",
  "personData.after.said": "その人、そのメッセージ、ご自身で追加した内容は残ります。",
  "personData.after.exclude": "設定 → メモリ → プライバシーで、再び許可できます。",
  "personData.after.exclude_forget": "設定 → メモリ → プライバシーで再び許可できますが、削除した内容は元に戻りません。",
  "personData.confirm.said": "言ったことを忘れる",
  "personData.confirm.exclude": "学習を停止",
  "personData.confirm.exclude_forget": "停止して忘れる",
  "personData.done.said": "{name}が言ったことを忘れました。",
  "personData.done.exclude": "{name}についての学習を停止しました。",
  "personData.done.exclude_forget": "{name}についての学習を停止し、言ったことを忘れました。",
};
