import type { Catalogue } from "../../index.ts";

/** Overview chart strings (it); merged into `../it.ts`. */
export const charts: Partial<Catalogue> = {
  "charts.delta.up": "{n} in più rispetto a {period}",
  "charts.delta.down": "{n} in meno rispetto a {period}",
  "charts.delta.flat": "Come {period}",
  "charts.delta.none": "Nessun periodo precedente da confrontare",
  "charts.delta.fraction": "{n} ({pct})",
  "charts.tile.name": "{label}: {value}. {delta}",
  "charts.legend.series": "Mostra o nascondi una serie",
  "charts.legend.fewer": "Meno",
  "charts.legend.more": "Più",
  "charts.legend.range": "{from}–{to}",
  "charts.legend.empty": "Nessuna attività",
  "charts.day.announce": "{date}: {total}, {parts}",
  "charts.day.none": "{date}: non è stato eseguito nulla",
  "charts.series.value": "{label}: {n}",
  "charts.total.runs": "{n, plural, one {# esecuzione} other {# esecuzioni}}",
  "charts.table.date": "Data",
  "charts.table.total": "Totale",
  "charts.hint":
    "Usa i tasti freccia per spostarti tra i giorni. Premi Invio per mostrare quel giorno.",
  "charts.bars.label": "Attività giornaliera",
  "charts.heatmap.label": "Attività per giorno",
};
