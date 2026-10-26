import type { Catalogue } from "../../index.ts";

/** Overview chart strings (fr); merged into `../fr.ts`. */
export const charts: Partial<Catalogue> = {
  "charts.delta.up": "{n} de plus que {period}",
  "charts.delta.down": "{n} de moins que {period}",
  "charts.delta.flat": "Identique à {period}",
  "charts.delta.none": "Aucune période précédente à comparer",
  "charts.delta.fraction": "{n} ({pct})",
  "charts.tile.name": "{label} : {value}. {delta}",
  "charts.legend.series": "Afficher ou masquer une série",
  "charts.legend.fewer": "Moins",
  "charts.legend.more": "Plus",
  "charts.legend.range": "{from}–{to}",
  "charts.legend.empty": "Aucune activité",
  "charts.day.announce": "{date} : {total}, {parts}",
  "charts.day.none": "{date} : rien ne s’est exécuté",
  "charts.series.value": "{label} : {n}",
  "charts.total.runs": "{n, plural, one {# exécution} other {# exécutions}}",
  "charts.table.date": "Date",
  "charts.table.total": "Total",
  "charts.hint":
    "Utilisez les touches fléchées pour passer d’un jour à l’autre. Appuyez sur Entrée pour afficher ce jour.",
  "charts.bars.label": "Activité quotidienne",
  "charts.heatmap.label": "Activité par jour",
};
