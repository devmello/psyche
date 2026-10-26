import type { Catalogue } from "../../index.ts";

/** Overview chart strings (ja); merged into `../ja.ts`. */
export const charts: Partial<Catalogue> = {
  "charts.delta.up": "{period}より{n}多い",
  "charts.delta.down": "{period}より{n}少ない",
  "charts.delta.flat": "{period}と同じ",
  "charts.delta.none": "比較できる前の期間はありません",
  "charts.delta.fraction": "{n}（{pct}）",
  "charts.tile.name": "{label}：{value}。{delta}",
  "charts.legend.series": "系列の表示と非表示を切り替え",
  "charts.legend.fewer": "少ない",
  "charts.legend.more": "多い",
  "charts.legend.range": "{from}～{to}",
  "charts.legend.empty": "アクティビティなし",
  "charts.day.announce": "{date}：{total}、{parts}",
  "charts.day.none": "{date}：実行なし",
  "charts.series.value": "{label}：{n}",
  "charts.total.runs": "{n, plural, other {#回の実行}}",
  "charts.table.date": "日付",
  "charts.table.total": "合計",
  "charts.hint": "矢印キーで日を移動します。Enterキーでその日を表示します。",
  "charts.bars.label": "1日ごとのアクティビティ",
  "charts.heatmap.label": "日別のアクティビティ",
};
