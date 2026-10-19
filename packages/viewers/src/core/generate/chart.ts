import {
  assertLimit,
  type ChartSpec,
  fileName,
  GENERATOR_LIMITS,
  type GeneratedFile,
  MIME,
} from "./model.ts";

/**
 * Static SVG charts (bar, line, pie): no scripts, no external references, every label escaped,
 * so the output is safe inline in Markdown previews, PDFs (`drawSvg`), artifacts and email.
 * Colours are fixed hex values (not CSS variables) because the SVG must render outside our CSS.
 */

export const CHART_PALETTE = [
  "#2563eb",
  "#ea580c",
  "#16a34a",
  "#9333ea",
  "#dc2626",
  "#0891b2",
  "#ca8a04",
  "#db2777",
];

const INK = "#1f2937";
const MUTED = "#6b7280";
const GRID = "#e5e7eb";
const FONT = "Helvetica, Arial, sans-serif";

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, "");
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) < 10 ? 2 : 1));
const r1 = (n: number) => Math.round(n * 10) / 10;

/** "Nice" axis ticks covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) max = min === 0 ? 1 : min + Math.abs(min);
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step)
    ticks.push(Number((Math.round(v / step) * step).toPrecision(12)));
  return ticks;
}

function text(
  x: number,
  y: number,
  s: string,
  opts: { anchor?: "start" | "middle" | "end"; size?: number; fill?: string; weight?: number } = {},
): string {
  const a = opts.anchor ?? "start";
  return `<text x="${r1(x)}" y="${r1(y)}" text-anchor="${a}" font-size="${opts.size ?? 12}" fill="${opts.fill ?? INK}"${opts.weight ? ` font-weight="${opts.weight}"` : ""}>${escapeXml(s)}</text>`;
}

/** Truncates long category labels so they do not overlap neighbours. */
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

function legend(spec: ChartSpec, x: number, y: number, names: string[]): string {
  let out = "";
  let cx = x;
  names.forEach((name, i) => {
    out += `<rect x="${r1(cx)}" y="${r1(y - 9)}" width="10" height="10" rx="2" fill="${CHART_PALETTE[i % CHART_PALETTE.length]}"/>`;
    const label = clip(name, 24);
    out += text(cx + 14, y, label, { size: 11, fill: MUTED });
    cx += 24 + label.length * 6.5;
  });
  return spec.series.length > 0 ? out : "";
}

function cartesian(spec: ChartSpec, w: number, h: number, top: number): string {
  const series = spec.series.filter((s) => s.values.length > 0);
  const n = spec.labels.length;
  const all = series.flatMap((s) => s.values.slice(0, n)).filter(Number.isFinite);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? 1;
  const unit = spec.unit ?? "";
  const left = 12 + Math.max(...ticks.map((t) => `${fmt(t)}${unit}`.length)) * 7;
  const bottom = h - 36;
  const right = w - 16;
  const plotH = bottom - top;
  const y = (v: number) => bottom - ((v - lo) / (hi - lo || 1)) * plotH;
  let out = "";
  for (const t of ticks) {
    out += `<line x1="${r1(left)}" x2="${r1(right)}" y1="${r1(y(t))}" y2="${r1(y(t))}" stroke="${t === 0 ? MUTED : GRID}" stroke-width="1"/>`;
    out += text(left - 6, y(t) + 4, `${fmt(t)}${unit}`, { anchor: "end", size: 11, fill: MUTED });
  }
  const band = (right - left) / Math.max(1, n);
  const maxChars = Math.max(3, Math.floor(band / 6.5));
  spec.labels.forEach((label, i) => {
    out += text(left + band * (i + 0.5), bottom + 16, clip(label, maxChars), {
      anchor: "middle",
      size: 11,
      fill: MUTED,
    });
  });
  if (spec.kind === "bar") {
    const groupW = band * 0.72;
    const barW = groupW / Math.max(1, series.length);
    series.forEach((s, si) => {
      const fill = CHART_PALETTE[si % CHART_PALETTE.length];
      s.values.slice(0, n).forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        const x = left + band * i + (band - groupW) / 2 + barW * si;
        const y0 = y(Math.max(0, v));
        const hgt = Math.abs(y(v) - y(0));
        out += `<rect x="${r1(x + 1)}" y="${r1(y0)}" width="${r1(Math.max(1, barW - 2))}" height="${r1(hgt)}" rx="2" fill="${fill}"><title>${escapeXml(`${s.name} · ${spec.labels[i] ?? ""}: ${fmt(v)}${unit}`)}</title></rect>`;
      });
    });
  } else {
    series.forEach((s, si) => {
      const stroke = CHART_PALETTE[si % CHART_PALETTE.length];
      const pts = s.values
        .slice(0, n)
        .map((v, i) => (Number.isFinite(v) ? `${r1(left + band * (i + 0.5))},${r1(y(v))}` : ""))
        .filter((p) => p !== "");
      out += `<polyline points="${pts.join(" ")}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      for (const p of pts) {
        const [cx, cy] = p.split(",");
        out += `<circle cx="${cx}" cy="${cy}" r="3" fill="${stroke}"/>`;
      }
    });
  }
  if (series.length > 1)
    out += legend(
      spec,
      left,
      h - 6,
      series.map((s) => s.name),
    );
  return out;
}

function pie(spec: ChartSpec, w: number, h: number, top: number): string {
  const values = (spec.series[0]?.values ?? []).slice(0, spec.labels.length);
  const total = values.reduce((a, v) => a + (Number.isFinite(v) && v > 0 ? v : 0), 0);
  const r = Math.min(w * 0.3, (h - top - 16) / 2);
  const cx = 16 + r;
  const cy = top + 8 + r;
  let out = "";
  let angle = -Math.PI / 2;
  values.forEach((v, i) => {
    if (!(v > 0) || total === 0) return;
    const fill = CHART_PALETTE[i % CHART_PALETTE.length];
    const sweep = (v / total) * Math.PI * 2;
    const label = escapeXml(`${spec.labels[i] ?? ""}: ${fmt(v)}${spec.unit ?? ""}`);
    if (sweep >= Math.PI * 2 - 1e-9) {
      out += `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}" fill="${fill}"><title>${label}</title></circle>`;
    } else {
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(angle + sweep);
      const y2 = cy + r * Math.sin(angle + sweep);
      const large = sweep > Math.PI ? 1 : 0;
      out += `<path d="M${r1(cx)} ${r1(cy)}L${r1(x1)} ${r1(y1)}A${r1(r)} ${r1(r)} 0 ${large} 1 ${r1(x2)} ${r1(y2)}Z" fill="${fill}" stroke="#ffffff" stroke-width="1"><title>${label}</title></path>`;
    }
    angle += sweep;
  });
  const lx = cx + r + 24;
  spec.labels.forEach((label, i) => {
    const v = values[i] ?? 0;
    const ly = top + 16 + i * 20;
    if (ly > h - 8) return;
    const pct = total > 0 && v > 0 ? ` (${Math.round((v / total) * 100)}%)` : "";
    out += `<rect x="${r1(lx)}" y="${r1(ly - 9)}" width="10" height="10" rx="2" fill="${CHART_PALETTE[i % CHART_PALETTE.length]}"/>`;
    out += text(lx + 16, ly, `${clip(label, 28)}${pct}`, { size: 12 });
  });
  return out;
}

/** Renders a chart as a standalone SVG document string. */
export function chartSvg(spec: ChartSpec): string {
  const points = spec.series.reduce((a, s) => a + s.values.length, 0);
  assertLimit(points, GENERATOR_LIMITS.chartPoints, "chart points");
  const w = Math.min(2000, Math.max(240, spec.width ?? 640));
  const h = Math.min(1500, Math.max(160, spec.height ?? 360));
  const top = spec.title ? 40 : 16;
  const title = spec.title ? text(16, 26, spec.title, { size: 15, weight: 600 }) : "";
  const body = spec.kind === "pie" ? pie(spec, w, h, top) : cartesian(spec, w, h, top);
  const label = escapeXml(spec.title ?? `${spec.kind} chart`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}" font-family="${FONT}"><rect width="${w}" height="${h}" fill="#ffffff"/>${title}${body}</svg>`;
}

export function generateChartSvg(spec: ChartSpec): GeneratedFile {
  return {
    name: fileName(spec.title ?? "chart", "svg"),
    mime: MIME.svg,
    bytes: new TextEncoder().encode(chartSvg(spec)),
  };
}
