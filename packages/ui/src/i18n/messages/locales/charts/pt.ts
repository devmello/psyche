import type { Catalogue } from "../../index.ts";

/** Overview chart strings (pt); merged into `../pt.ts`. */
export const charts: Partial<Catalogue> = {
  "charts.delta.up": "{n} a mais que {period}",
  "charts.delta.down": "{n} a menos que {period}",
  "charts.delta.flat": "Igual a {period}",
  "charts.delta.none": "Não há período anterior para comparar",
  "charts.delta.fraction": "{n} ({pct})",
  "charts.tile.name": "{label}: {value}. {delta}",
  "charts.legend.series": "Mostrar ou ocultar uma série",
  "charts.legend.fewer": "Menos",
  "charts.legend.more": "Mais",
  "charts.legend.range": "{from}–{to}",
  "charts.legend.empty": "Sem atividade",
  "charts.day.announce": "{date}: {total}, {parts}",
  "charts.day.none": "{date}: nada foi executado",
  "charts.series.value": "{label}: {n}",
  "charts.total.runs": "{n, plural, one {# execução} other {# execuções}}",
  "charts.table.date": "Data",
  "charts.table.total": "Total",
  "charts.hint":
    "Use as teclas de seta para mover entre os dias. Pressione Enter para mostrar esse dia.",
  "charts.bars.label": "Atividade diária",
  "charts.heatmap.label": "Atividade por dia",
};
