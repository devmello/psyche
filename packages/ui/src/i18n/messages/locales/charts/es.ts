import type { Catalogue } from "../../index.ts";

/** Overview chart strings (es); merged into `../es.ts`. */
export const charts: Partial<Catalogue> = {
  "charts.delta.up": "{n} más que {period}",
  "charts.delta.down": "{n} menos que {period}",
  "charts.delta.flat": "Igual que {period}",
  "charts.delta.none": "No hay un periodo anterior con el que comparar",
  "charts.delta.fraction": "{n} ({pct})",
  "charts.tile.name": "{label}: {value}. {delta}",
  "charts.legend.series": "Mostrar u ocultar una serie",
  "charts.legend.fewer": "Menos",
  "charts.legend.more": "Más",
  "charts.legend.range": "{from}–{to}",
  "charts.legend.empty": "Sin actividad",
  "charts.day.announce": "{date}: {total}, {parts}",
  "charts.day.none": "{date}: no se ejecutó nada",
  "charts.series.value": "{label}: {n}",
  "charts.total.runs": "{n, plural, one {# ejecución} other {# ejecuciones}}",
  "charts.table.date": "Fecha",
  "charts.table.total": "Total",
  "charts.hint":
    "Usa las teclas de flecha para moverte entre días. Pulsa Intro para mostrar ese día.",
  "charts.bars.label": "Actividad diaria",
  "charts.heatmap.label": "Actividad por día",
};
