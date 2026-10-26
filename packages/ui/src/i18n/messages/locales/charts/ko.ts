import type { Catalogue } from "../../index.ts";

/** Overview chart strings (ko); merged into `../ko.ts`. */
export const charts: Partial<Catalogue> = {
  "charts.delta.up": "{period}보다 {n} 많음",
  "charts.delta.down": "{period}보다 {n} 적음",
  "charts.delta.flat": "{period}와 같음",
  "charts.delta.none": "비교할 이전 기간이 없습니다",
  "charts.delta.fraction": "{n}({pct})",
  "charts.tile.name": "{label}: {value}. {delta}",
  "charts.legend.series": "계열 표시 또는 숨기기",
  "charts.legend.fewer": "적음",
  "charts.legend.more": "많음",
  "charts.legend.range": "{from}–{to}",
  "charts.legend.empty": "활동 없음",
  "charts.day.announce": "{date}: {total}, {parts}",
  "charts.day.none": "{date}: 실행 없음",
  "charts.series.value": "{label}: {n}",
  "charts.total.runs": "{n, plural, other {#회 실행}}",
  "charts.table.date": "날짜",
  "charts.table.total": "합계",
  "charts.hint": "화살표 키로 날짜 사이를 이동합니다. Enter 키를 누르면 해당 날짜를 표시합니다.",
  "charts.bars.label": "일별 활동",
  "charts.heatmap.label": "날짜별 활동",
};
