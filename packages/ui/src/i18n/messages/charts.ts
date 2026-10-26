/** Overview chart primitives: tiles, stacked bars, calendar heatmap (`components/charts/`). */
export const charts = {
  // Delta chip words (the arrow glyph is drawn beside them; never red or green).
  "charts.delta.up": "{n} more than {period}",
  "charts.delta.down": "{n} fewer than {period}",
  "charts.delta.flat": "Same as {period}",
  "charts.delta.none": "No earlier period to compare",
  "charts.delta.fraction": "{n} ({pct})",
  // A tile link's accessible name: the number and the delta in words.
  "charts.tile.name": "{label}: {value}. {delta}",

  "charts.legend.series": "Show or hide a series",
  "charts.legend.fewer": "Fewer",
  "charts.legend.more": "More",
  "charts.legend.range": "{from}–{to}",
  "charts.legend.empty": "No activity",

  // "Tue, Oct 14: 23 runs, 18 tasks, 5 automations"
  "charts.day.announce": "{date}: {total}, {parts}",
  "charts.day.none": "{date}: nothing ran",
  "charts.series.value": "{label}: {n}",
  "charts.total.runs": "{n, plural, one {# run} other {# runs}}",

  "charts.table.date": "Date",
  "charts.table.total": "Total",
  "charts.hint": "Use the arrow keys to move between days. Press Enter to show that day.",
  "charts.bars.label": "Daily activity",
  "charts.heatmap.label": "Activity by day",
} as const;
