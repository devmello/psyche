import type { Catalogue } from "../../index.ts";

/** Overview Growth and People & projects strings (ja); merged into `../ja.ts`. */
export const overviewGrowth: Partial<Catalogue> = {
  "overview.meta.7d": "過去7日間",
  "overview.meta.30d": "過去30日間",
  "overview.meta.all": "全期間",
  "overview.growth.loading": "成長を読み込み中",
  "overview.growth.loadFailed": "成長を読み込めませんでした",
  "overview.growth.empty": "この期間にはまだ学んだことがありません。",
  "overview.growth.counts": "この期間のレッスン",
  "overview.growth.learned": "{n, plural, other {#件のレッスンを学習}}",
  "overview.growth.refined": "{n, plural, other {#件を改善}}",
  "overview.growth.confirmed": "{n, plural, other {#件を確認済み}}",
  "overview.growth.forgotten": "{n, plural, other {#件を削除}}",
  "overview.growth.milestones": "マイルストーン",
  "overview.growth.seeAll": "すべてのレッスンを見る",
  "overview.growth.sheetTitle": "{agent}が学んだこと",
  "overview.growth.evidenceTitle": "「{metric}」の根拠となるイベント",
  "overview.growth.card.thisWeek": "今週のレッスン（{n}）",
  "overview.growth.card.week": "{date}の週のレッスン（{n}）",
  "overview.growth.card.review": "確認する",
  "overview.growth.card.sheetTitle": "今週{agent}が学んだこと",
  "overview.growth.card.sheetDescription":
    "{agent}が覚えたことを、残す・編集する・忘れるから選べます。",
  "overview.people.loading": "人とプロジェクトを読み込み中",
  "overview.people.loadFailed": "人とプロジェクトを読み込めませんでした",
  "overview.people.paused":
    "人とプロジェクトのグラフは一時停止中のため、何も記録されていません。ここに表示するには設定でオンにしてください。",
  "overview.people.empty":
    "この期間にはまだ誰もいません。{agent}があなたの代わりに関わると、人やプロジェクトがここに表示されます。",
  "overview.people.map": "人とプロジェクトのマップ",
  "overview.people.mapHint":
    "矢印キーでやり取りの多い順に人やプロジェクトを移動できます。Enterで開きます。",
  "overview.people.caption":
    "中心に近いほど最近のやり取りです。大きいほどやり取りが多いことを表します。丸は人、四角はプロジェクトと組織です。",
  "overview.people.you": "あなた",
  "overview.people.ring.0": "今週",
  "overview.people.ring.1": "今月",
  "overview.people.ring.2": "それ以前",
  "overview.people.kind.person": "人",
  "overview.people.kind.org": "組織",
  "overview.people.kind.project": "プロジェクト",
  "overview.people.kind.place": "場所",
  "overview.people.interactions": "{n, plural, other {やり取り#件}}",
  "overview.people.openLoops": "{n, plural, other {未完了の項目#件}}",
  "overview.people.last": "最後のやり取り: {when}",
  "overview.people.node": "{name}、{kind}。{interactions}。最後のやり取り: {when}。{loops}。",
  "overview.people.detailHint":
    "人やプロジェクトにポインターを合わせるかフォーカスすると、詳細が表示されます。",
  "overview.people.counts":
    "{people, plural, other {#人}} · {projects, plural, other {#件のプロジェクト}} · {loops, plural, other {未完了#件}}",
  "overview.people.ranked": "{name} {n}",
  "overview.people.showList": "リストで表示",
  "overview.people.showMap": "マップを表示",
  "overview.people.seeAll": "すべて見る",
  "overview.people.list": "人とプロジェクト（やり取りの多い順）",
  "overview.people.table.name": "名前",
  "overview.people.table.kind": "種類",
  "overview.people.table.interactions": "やり取り",
  "overview.people.table.last": "最後のやり取り",
  "overview.people.table.loops": "未完了",
};
