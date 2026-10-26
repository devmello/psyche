import type { Catalogue } from "../../index.ts";

/** Overview chart strings (hi); merged into `../hi.ts`. */
export const charts: Partial<Catalogue> = {
  "charts.delta.up": "{period} से {n} अधिक",
  "charts.delta.down": "{period} से {n} कम",
  "charts.delta.flat": "{period} के बराबर",
  "charts.delta.none": "तुलना के लिए कोई पिछली अवधि नहीं",
  "charts.delta.fraction": "{n} ({pct})",
  "charts.tile.name": "{label}: {value}। {delta}",
  "charts.legend.series": "किसी श्रृंखला को दिखाएँ या छिपाएँ",
  "charts.legend.fewer": "कम",
  "charts.legend.more": "अधिक",
  "charts.legend.range": "{from}–{to}",
  "charts.legend.empty": "कोई गतिविधि नहीं",
  "charts.day.announce": "{date}: {total}, {parts}",
  "charts.day.none": "{date}: कुछ नहीं चला",
  "charts.series.value": "{label}: {n}",
  "charts.total.runs": "{n, plural, one {# रन} other {# रन}}",
  "charts.table.date": "तारीख़",
  "charts.table.total": "कुल",
  "charts.hint": "दिनों के बीच जाने के लिए तीर कुंजियाँ इस्तेमाल करें। उस दिन को दिखाने के लिए Enter दबाएँ।",
  "charts.bars.label": "दैनिक गतिविधि",
  "charts.heatmap.label": "दिन के अनुसार गतिविधि",
};
