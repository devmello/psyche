import type { Catalogue } from "../../index.ts";

/** Overview chart strings (zh); merged into `../zh.ts`. */
export const charts: Partial<Catalogue> = {
  "charts.delta.up": "比{period}多{n}",
  "charts.delta.down": "比{period}少{n}",
  "charts.delta.flat": "与{period}相同",
  "charts.delta.none": "没有可比较的上一个时段",
  "charts.delta.fraction": "{n}（{pct}）",
  "charts.tile.name": "{label}：{value}。{delta}",
  "charts.legend.series": "显示或隐藏数据系列",
  "charts.legend.fewer": "较少",
  "charts.legend.more": "较多",
  "charts.legend.range": "{from}–{to}",
  "charts.legend.empty": "没有活动",
  "charts.day.announce": "{date}：{total}，{parts}",
  "charts.day.none": "{date}：没有运行",
  "charts.series.value": "{label}：{n}",
  "charts.total.runs": "{n, plural, other {#次运行}}",
  "charts.table.date": "日期",
  "charts.table.total": "总计",
  "charts.hint": "使用方向键在各天之间移动。按 Enter 键显示当天。",
  "charts.bars.label": "每日活动",
  "charts.heatmap.label": "按天显示的活动",
};
