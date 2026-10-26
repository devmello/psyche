import type { Catalogue } from "../../index.ts";

/** Overview chart strings (ar); merged into `../ar.ts`. */
export const charts: Partial<Catalogue> = {
  "charts.delta.up": "{n} أكثر من {period}",
  "charts.delta.down": "{n} أقل من {period}",
  "charts.delta.flat": "مثل {period}",
  "charts.delta.none": "لا توجد فترة سابقة للمقارنة",
  "charts.delta.fraction": "{n} ({pct})",
  "charts.tile.name": "{label}: {value}. {delta}",
  "charts.legend.series": "إظهار سلسلة أو إخفاؤها",
  "charts.legend.fewer": "أقل",
  "charts.legend.more": "أكثر",
  "charts.legend.range": "{from}–{to}",
  "charts.legend.empty": "لا نشاط",
  "charts.day.announce": "{date}: {total}، {parts}",
  "charts.day.none": "{date}: لم يُشغَّل شيء",
  "charts.series.value": "{label}: {n}",
  "charts.total.runs":
    "{n, plural, zero {لا عمليات تشغيل} one {تشغيل واحد} two {تشغيلان} few {# عمليات تشغيل} many {# عملية تشغيل} other {# عملية تشغيل}}",
  "charts.table.date": "التاريخ",
  "charts.table.total": "الإجمالي",
  "charts.hint": "استخدم مفاتيح الأسهم للتنقل بين الأيام. اضغط Enter لعرض ذلك اليوم.",
  "charts.bars.label": "النشاط اليومي",
  "charts.heatmap.label": "النشاط حسب اليوم",
};
