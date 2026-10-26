import type { Catalogue } from "../../index.ts";

/** Overview chart strings (de); merged into `../de.ts`. */
export const charts: Partial<Catalogue> = {
  "charts.delta.up": "{n} mehr als {period}",
  "charts.delta.down": "{n} weniger als {period}",
  "charts.delta.flat": "Wie {period}",
  "charts.delta.none": "Kein früherer Zeitraum zum Vergleich",
  "charts.delta.fraction": "{n} ({pct})",
  "charts.tile.name": "{label}: {value}. {delta}",
  "charts.legend.series": "Reihe ein- oder ausblenden",
  "charts.legend.fewer": "Weniger",
  "charts.legend.more": "Mehr",
  "charts.legend.range": "{from}–{to}",
  "charts.legend.empty": "Keine Aktivität",
  "charts.day.announce": "{date}: {total}, {parts}",
  "charts.day.none": "{date}: nichts ausgeführt",
  "charts.series.value": "{label}: {n}",
  "charts.total.runs": "{n, plural, one {# Lauf} other {# Läufe}}",
  "charts.table.date": "Datum",
  "charts.table.total": "Gesamt",
  "charts.hint":
    "Mit den Pfeiltasten zwischen den Tagen wechseln. Mit der Eingabetaste diesen Tag anzeigen.",
  "charts.bars.label": "Tägliche Aktivität",
  "charts.heatmap.label": "Aktivität pro Tag",
};
