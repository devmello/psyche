import { type BuiltArtifact, buildArtifactSrcdoc } from "../artifact.ts";
import { chartSvg, escapeXml } from "./chart.ts";
import {
  assertLimit,
  type Block,
  type ChartSpec,
  cellText,
  type DocSpec,
  fileName,
  GENERATOR_LIMITS,
  type GeneratedFile,
  MIME,
  parseInline,
} from "./model.ts";

/**
 * HTML templates (P8): a generic document, a trip itinerary and a dashboard. Output is static,
 * script-free HTML with inline styles and inline SVG charts; every model string is escaped.
 * Show it through the artifact sandbox (`templateArtifact` → srcdoc with the strict CSP and
 * scripts off) or print it with Chromium for a full-Unicode PDF.
 */

export const escapeHtml = escapeXml;

function inline(text: string): string {
  return parseInline(text)
    .map((r) => {
      const t = escapeHtml(r.text);
      if (r.code) return `<code>${t}</code>`;
      if (r.bold) return `<strong>${t}</strong>`;
      if (r.italic) return `<em>${t}</em>`;
      return t;
    })
    .join("")
    .replace(/\n/g, "<br>");
}

const BASE_CSS = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2937;--muted:#6b7280;--rule:#e5e7eb;--card:#f9fafb;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#111827;--fg:#e5e7eb;--muted:#9ca3af;--rule:#374151;--card:#1f2937;--accent:#60a5fa}}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto}
h1{font-size:26px;line-height:1.2;margin:0 0 4px}h2{font-size:20px;margin:28px 0 8px}h3{font-size:16px;margin:20px 0 6px}
.muted{color:var(--muted)}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px;display:block;overflow-x:auto}
th,td{border-bottom:1px solid var(--rule);padding:6px 10px;text-align:left;vertical-align:top}
th{background:var(--card);font-weight:600}
td.num{text-align:right;font-variant-numeric:tabular-nums}
pre{background:var(--card);padding:12px;border-radius:8px;overflow-x:auto;font-size:13px}
code{font-family:ui-monospace,Menlo,monospace;font-size:.92em}
blockquote{margin:12px 0;padding:2px 14px;border-left:3px solid var(--rule);color:var(--muted)}
figure{margin:16px 0}figure svg{max-width:100%;height:auto;border-radius:8px}
.page-break{break-after:page;height:0}
@media print{body{padding:0}.page-break{display:block}}
`;

function page(title: string, body: string, css = ""): string {
  return `<title>${escapeHtml(title)}</title><style>${BASE_CSS}${css}</style><main>${body}</main>`;
}

function tableHtml(columns: string[], rows: (string | number | boolean | null)[][]): string {
  assertLimit(rows.length, GENERATOR_LIMITS.tableRows, "table rows");
  const head = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${r
          .map((v) =>
            typeof v === "number"
              ? `<td class="num">${escapeHtml(cellText(v))}</td>`
              : `<td>${escapeHtml(cellText(v))}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  return `<table>${head ? `<thead><tr>${head}</tr></thead>` : ""}<tbody>${body}</tbody></table>`;
}

function figure(chart: ChartSpec): string {
  return `<figure>${chartSvg(chart)}</figure>`;
}

function blockHtml(b: Block): string {
  switch (b.type) {
    case "heading":
      return `<h${b.level + 1}>${escapeHtml(b.text)}</h${b.level + 1}>`;
    case "paragraph":
      return `<p>${inline(b.text)}</p>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      return `<${tag}>${b.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${tag}>`;
    }
    case "table":
      return tableHtml(b.columns, b.rows);
    case "code":
      return `<pre><code>${escapeHtml(b.text)}</code></pre>`;
    case "quote":
      return `<blockquote><p>${inline(b.text)}</p></blockquote>`;
    case "chart":
      return figure(b.chart);
    case "pageBreak":
      return '<div class="page-break"></div>';
  }
}

export function docToHtml(spec: DocSpec): string {
  assertLimit(spec.blocks.length, GENERATOR_LIMITS.blocks, "blocks");
  const head = `<h1>${escapeHtml(spec.title)}</h1>${spec.author ? `<p class="muted">${escapeHtml(spec.author)}</p>` : ""}`;
  return page(spec.title, head + spec.blocks.map(blockHtml).join("\n"));
}

export interface ItineraryItem {
  /** "09:30" or "Morning". */
  time?: string;
  title: string;
  kind?: "flight" | "train" | "car" | "hotel" | "meal" | "activity" | "meeting" | "other";
  location?: string;
  notes?: string;
  /** Booking reference, shown as-is (never a card number; the vault keeps those). */
  confirmation?: string;
}

export interface ItineraryDay {
  /** ISO date "2026-11-03" or free text. */
  date: string;
  title?: string;
  items: ItineraryItem[];
}

export interface ItinerarySpec {
  title: string;
  travelers?: string[];
  summary?: string;
  days: ItineraryDay[];
}

const KIND_ICON: Record<NonNullable<ItineraryItem["kind"]>, string> = {
  flight: "✈︎",
  train: "🚆",
  car: "🚗",
  hotel: "🏨",
  meal: "🍽",
  activity: "★",
  meeting: "👥",
  other: "•",
};

function formatDay(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

const ITINERARY_CSS = `
.day{margin:20px 0;padding:16px;border:1px solid var(--rule);border-radius:12px;background:var(--card)}
.day h2{margin:0 0 10px;font-size:17px}
.item{display:grid;grid-template-columns:64px 24px 1fr;gap:4px 8px;padding:8px 0;border-top:1px solid var(--rule)}
.item:first-of-type{border-top:0}
.time{color:var(--muted);font-variant-numeric:tabular-nums}
.what{font-weight:600}.where,.notes{grid-column:3;color:var(--muted);font-size:14px}
.conf{grid-column:3;font-family:ui-monospace,Menlo,monospace;font-size:13px}
@media (max-width:480px){.item{grid-template-columns:52px 20px 1fr}}
`;

export function itineraryHtml(spec: ItinerarySpec): string {
  assertLimit(
    spec.days.reduce((a, d) => a + d.items.length, 0),
    GENERATOR_LIMITS.tableRows,
    "itinerary items",
  );
  const head = [
    `<h1>${escapeHtml(spec.title)}</h1>`,
    spec.travelers?.length ? `<p class="muted">${escapeHtml(spec.travelers.join(", "))}</p>` : "",
    spec.summary ? `<p>${inline(spec.summary)}</p>` : "",
  ].join("");
  const days = spec.days
    .map((d) => {
      const items = d.items
        .map((it) =>
          [
            '<div class="item">',
            `<span class="time">${escapeHtml(it.time ?? "")}</span>`,
            `<span aria-hidden="true">${KIND_ICON[it.kind ?? "other"] ?? "•"}</span>`,
            `<span class="what">${escapeHtml(it.title)}</span>`,
            it.location ? `<span class="where">${escapeHtml(it.location)}</span>` : "",
            it.notes ? `<span class="notes">${inline(it.notes)}</span>` : "",
            it.confirmation
              ? `<span class="conf">Confirmation ${escapeHtml(it.confirmation)}</span>`
              : "",
            "</div>",
          ].join(""),
        )
        .join("");
      const title = `${escapeHtml(formatDay(d.date))}${d.title ? ` · ${escapeHtml(d.title)}` : ""}`;
      return `<section class="day"><h2>${title}</h2>${items}</section>`;
    })
    .join("");
  return page(spec.title, head + days, ITINERARY_CSS);
}

export interface DashboardKpi {
  label: string;
  value: string | number;
  /** "+12%" / "-3". Leading sign picks the colour. */
  delta?: string;
  hint?: string;
}

export interface DashboardSpec {
  title: string;
  subtitle?: string;
  kpis?: DashboardKpi[];
  charts?: ChartSpec[];
  tables?: { title?: string; columns: string[]; rows: (string | number | boolean | null)[][] }[];
  /** ISO timestamp shown as "Updated …". */
  updatedAt?: string;
}

const DASHBOARD_CSS = `
main{max-width:1100px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:16px 0}
.kpi{padding:14px 16px;border:1px solid var(--rule);border-radius:12px;background:var(--card)}
.kpi .label{color:var(--muted);font-size:13px}
.kpi .value{font-size:26px;font-weight:650;font-variant-numeric:tabular-nums;margin-top:2px}
.kpi .delta{font-size:13px;font-weight:600}.up{color:#16a34a}.down{color:#dc2626}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:12px}
.panel{padding:12px;border:1px solid var(--rule);border-radius:12px;background:var(--card);min-width:0}
.panel h2{font-size:15px;margin:0 0 6px}
`;

export function dashboardHtml(spec: DashboardSpec): string {
  const kpis = (spec.kpis ?? [])
    .map((k) => {
      const d = k.delta?.trim();
      const cls = d?.startsWith("-") || d?.startsWith("−") ? "down" : d ? "up" : "";
      return [
        '<div class="kpi">',
        `<div class="label">${escapeHtml(k.label)}</div>`,
        `<div class="value">${escapeHtml(String(k.value))}</div>`,
        d ? `<div class="delta ${cls}">${escapeHtml(d)}</div>` : "",
        k.hint ? `<div class="label">${escapeHtml(k.hint)}</div>` : "",
        "</div>",
      ].join("");
    })
    .join("");
  const charts = (spec.charts ?? [])
    .map((c) => `<div class="panel">${chartSvg({ width: 520, height: 300, ...c })}</div>`)
    .join("");
  const tables = (spec.tables ?? [])
    .map(
      (t) =>
        `<div class="panel">${t.title ? `<h2>${escapeHtml(t.title)}</h2>` : ""}${tableHtml(t.columns, t.rows)}</div>`,
    )
    .join("");
  const updated = spec.updatedAt ? `Updated ${escapeHtml(spec.updatedAt)}` : "";
  const sub = [spec.subtitle ? escapeHtml(spec.subtitle) : "", updated].filter(Boolean).join(" · ");
  const body = [
    `<h1>${escapeHtml(spec.title)}</h1>`,
    sub ? `<p class="muted">${sub}</p>` : "",
    kpis ? `<div class="kpis">${kpis}</div>` : "",
    charts ? `<div class="charts">${charts}</div>` : "",
    tables ? `<div class="charts" style="margin-top:12px">${tables}</div>` : "",
  ].join("");
  return page(spec.title, body, DASHBOARD_CSS);
}

/** Wraps template HTML for the artifact frame: strict CSP, scripts off, bridge only. */
export function templateArtifact(html: string): BuiltArtifact {
  return buildArtifactSrcdoc(html, { allowScripts: false });
}

/** Standalone `.html` file (for "save to Library" or Chromium print). */
export function htmlFile(title: string, html: string): GeneratedFile {
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"></head><body>${html}</body></html>`;
  return { name: fileName(title, "html"), mime: MIME.html, bytes: new TextEncoder().encode(doc) };
}
