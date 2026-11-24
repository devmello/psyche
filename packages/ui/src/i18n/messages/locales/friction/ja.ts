import type { Catalogue } from "../../index.ts";

/** Approval-friction and person-interaction strings (ja); merged into `../ja.ts`. */
export const friction: Partial<Catalogue> = {
  "friction.title": "承認の手間",
  "friction.hint":
    "Psycheが行動前に確認のために止まる頻度と、あなたの応答の傾向です。件数のみ、監査ログから集計しています。",
  "friction.window": "期間",
  "friction.window.days": "直近{days}日",
  "friction.loading": "承認を集計しています…",
  "friction.error": "承認の手間を読み込めませんでした: {reason}",
  "friction.retry": "再試行",
  "friction.empty": "この期間にPsycheが確認した操作はないため、表示する内容がありません。",
  "friction.since": "{date}以降",
  "friction.asked":
    "確認した{decisions, plural, one {# 件} other {# 件}}の操作のうち、{asks, plural, one {# 件} other {# 件}}について確認しました（{rate}%）。",
  "friction.perRun": "少なくとも1回確認したランでは、平均 {n} 回確認していました。",
  "friction.answered": "終了した確認のうち、期限切れの前に回答されたものは {rate}% です。",
  "friction.approved": "終了した確認のうち、承認されたものは {rate}% です。",
  "friction.noTimes": "この期間に回答された確認はないため、回答時間はありません。",
  "friction.times": "回答までの中央値は {p50} でした。最も遅い1割は {p90} 以上かかりました。",
  "friction.expired":
    "{n, plural, =0 {期限切れのまま回答されなかった確認はありません。} other {期限切れのまま回答されなかった確認が # 件あります。}}",
  "friction.rejected":
    "{n, plural, =0 {拒否された回答はありません。} other {無効として拒否された回答が # 件あります。}}",
  "friction.saved":
    "{n, plural, =0 {標準の許可で確認なしに実行された操作はありません。} other {標準の許可で確認なしに実行された操作が # 件あります。}}",
  "friction.grantsCreated":
    "{n, plural, =0 {作成された標準の許可はありません。} other {作成された標準の許可が # 件あります。}}",
  "friction.kinds": "確認が発生した操作",
  "friction.kind.row": "{kind}: 確認 {asks}、承認 {approved}、拒否 {declined}、期限切れ {expired}",
  "friction.rules": "確認が多い理由",
  "friction.rule.row": "{label}: {count}",
  "friction.rule.mode": "モード設定",
  "friction.rule.taint": "外部からの内容",
  "friction.rule.policy": "ポリシー",
  "friction.rule.designated": "保護された場所",
  "friction.rule.site": "サイトのルール",
  "friction.rule.other": "その他のルール",
  "friction.modes": "モード別",
  "friction.mode.row": "{mode}: {decisions} 件中 {asks} 件で確認",

  "people.interactions.title": "最近のやり取り",
  "people.interactions.empty": "{name}とのやり取りはまだありません。",
  "people.interactions.error": "やり取りを読み込めませんでした: {reason}",
  "people.interactions.more": "さらに表示",
  "people.interactions.loadingMore": "読み込み中…",
};
