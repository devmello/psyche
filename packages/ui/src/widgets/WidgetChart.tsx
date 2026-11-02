import { type ReactElement, useId, useState } from "react";
import { activeI18n, t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";

/**
 * Small in-house SVG charts for widgets (generative-ui-2026 §4.2, §9, §10.1): bar, line and
 * sparkline, up to 4 series on the existing tokens. No chart library joins the bundle or the heap.
 * Colour is never the only signal: series differ by dash pattern and marker shape too, a legend
 * names them, the SVG carries a one-line spoken summary, and "Show data" reveals the same numbers
 * as a real table (also present, visually hidden, for screen readers when closed).
 */

type N = Record<string, unknown>;
interface Series {
  name: string;
  points: Array<{ x: string; y: number }>;
}

const COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-label-secondary)",
];
const DASH = [undefined, "6 3", "2 3", "8 3 2 3"] as const;
const W = 320;
const H = 150;
const M = { l: 44, r: 10, t: 10, b: 22 };

const fmt = (n: number): string =>
  activeI18n().number(n, { notation: "compact", maximumFractionDigits: 1 });

function readSeries(n: N): Series[] {
  const raw = Array.isArray(n.series) ? (n.series as N[]) : [];
  return raw.slice(0, 4).map((s) => ({
    name: String(s.name ?? ""),
    points: (Array.isArray(s.points) ? (s.points as N[]) : []).slice(0, 365).map((p) => ({
      x: String(p.x ?? ""),
      y: typeof p.y === "number" && Number.isFinite(p.y) ? p.y : 0,
    })),
  }));
}

/** A round upper bound for the axis, so ticks read as 0, 50, 100 and not 0, 47.3, 94.6. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function Marker({ i, x, y }: { i: number; x: number; y: number }): ReactElement {
  const c = { fill: COLORS[i], stroke: "var(--color-background)", strokeWidth: 1 };
  if (i === 0) return <circle cx={x} cy={y} r={3} style={c} />;
  if (i === 1) return <rect x={x - 3} y={y - 3} width={6} height={6} style={c} />;
  if (i === 2)
    return <polygon points={`${x},${y - 4} ${x + 4},${y + 3} ${x - 4},${y + 3}`} style={c} />;
  return <polygon points={`${x},${y - 4} ${x + 4},${y} ${x},${y + 4} ${x - 4},${y}`} style={c} />;
}

export default function WidgetChart({ node }: { node: N }): ReactElement | null {
  const label = String(node.label ?? "");
  const kind = node.kind === "line" || node.kind === "sparkline" ? node.kind : "bar";
  const unit = typeof node.unit === "string" && node.unit ? node.unit : "";
  const series = readSeries(node);
  const [open, setOpen] = useState(false);
  const tableId = useId();
  const count = Math.max(0, ...series.map((s) => s.points.length));
  if (series.length === 0 || count === 0) return null;
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  const lo = Math.min(0, ...ys);
  const hi = Math.max(0, ...ys);
  const top = niceMax(hi);
  const bottom = lo < 0 ? -niceMax(-lo) : 0;
  const first = series[0]?.points[0]?.x ?? "";
  const last = series[0]?.points[count - 1]?.x ?? "";
  const summary = t("widgets.chart.summary", {
    label,
    kind,
    series: series.length,
    points: count,
    from: first,
    to: last,
    min: fmt(Math.min(...ys)),
    max: fmt(Math.max(...ys)),
    unit: unit ? t("widgets.chart.unit", { unit }) : "",
  });
  const table = (
    <table id={tableId} className={cn("w-full border-collapse text-callout", !open && "sr-only")}>
      <caption className="sr-only">{summary}</caption>
      <thead>
        <tr>
          <th scope="col" className="px-2 py-0.5 text-start font-medium text-label-secondary">
            {t("widgets.chart.x")}
          </th>
          {series.map((s) => (
            <th
              key={s.name}
              scope="col"
              className="px-2 py-0.5 text-end font-medium text-label-secondary"
            >
              {s.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: count }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: points are positional
          <tr key={i} className="border-border border-t">
            <th scope="row" className="px-2 py-0.5 text-start font-normal">
              {series[0]?.points[i]?.x ?? ""}
            </th>
            {series.map((s) => (
              <td key={s.name} className="px-2 py-0.5 text-end tabular-nums">
                {s.points[i] ? activeI18n().number(s.points[i].y) : ""}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  if (kind === "sparkline") {
    const s = series[0] as Series;
    const sw = 120;
    const sh = 28;
    const pad = 3;
    const min = Math.min(...s.points.map((p) => p.y));
    const max = Math.max(...s.points.map((p) => p.y));
    const span = max - min || 1;
    const px = (i: number) =>
      pad +
      (s.points.length === 1 ? (sw - 2 * pad) / 2 : (i * (sw - 2 * pad)) / (s.points.length - 1));
    const py = (v: number) => sh - pad - ((v - min) / span) * (sh - 2 * pad);
    const d = s.points
      .map((p, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(p.y).toFixed(1)}`)
      .join("");
    return (
      <div className="inline-flex flex-col gap-1">
        <svg width={sw} height={sh} viewBox={`0 0 ${sw} ${sh}`} role="img" aria-label={summary}>
          <path
            d={d}
            fill="none"
            style={{ stroke: COLORS[0] }}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
          <circle
            cx={px(s.points.length - 1)}
            cy={py(s.points[s.points.length - 1]?.y ?? 0)}
            r={2.5}
            style={{ fill: COLORS[0] }}
          />
        </svg>
        {table}
      </div>
    );
  }

  const plotW = W - M.l - M.r;
  const plotH = H - M.t - M.b;
  const y = (v: number) => M.t + plotH - ((v - bottom) / (top - bottom || 1)) * plotH;
  const groupW = plotW / count;
  const xAt = (i: number) =>
    M.l +
    (kind === "bar" ? groupW * (i + 0.5) : count === 1 ? plotW / 2 : (i * plotW) / (count - 1));
  const ticks = [bottom, (bottom + top) / 2, top];
  const mid = Math.floor((count - 1) / 2);
  const labelIdx = Array.from(new Set(count >= 5 ? [0, mid, count - 1] : [0, count - 1]));
  const barW = (groupW * 0.8) / series.length;

  return (
    <figure className="flex flex-col gap-1.5" aria-label={label}>
      <figcaption className="text-callout text-label-secondary">
        {label}
        {unit ? <span className="ms-1">({unit})</span> : null}
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full max-w-[28rem]"
        role="img"
        aria-label={summary}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={M.l}
              x2={W - M.r}
              y1={y(v)}
              y2={y(v)}
              style={{ stroke: "var(--color-border)" }}
              strokeWidth={1}
            />
            <text
              x={M.l - 6}
              y={y(v)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={10}
              style={{ fill: "var(--color-label-secondary)" }}
            >
              {fmt(v)}
            </text>
          </g>
        ))}
        {lo < 0 ? (
          <line
            x1={M.l}
            x2={W - M.r}
            y1={y(0)}
            y2={y(0)}
            style={{ stroke: "var(--color-separator-strong)" }}
            strokeWidth={1}
          />
        ) : null}
        {kind === "bar"
          ? series.map((s, si) =>
              s.points.map((p, i) => {
                const x0 = xAt(i) - (barW * series.length) / 2 + si * barW;
                const y0 = y(Math.max(0, p.y));
                const h = Math.abs(y(p.y) - y(0));
                return (
                  <rect
                    // biome-ignore lint/suspicious/noArrayIndexKey: points are positional
                    key={`${si}-${i}`}
                    x={x0}
                    y={y0}
                    width={Math.max(1, barW - 1)}
                    height={Math.max(h, p.y === 0 ? 0 : 1)}
                    rx={1}
                    style={{ fill: COLORS[si] }}
                  />
                );
              }),
            )
          : series.map((s, si) => (
              <g key={s.name}>
                <path
                  d={s.points
                    .map(
                      (p, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${y(p.y).toFixed(1)}`,
                    )
                    .join("")}
                  fill="none"
                  style={{ stroke: COLORS[si] }}
                  strokeWidth={1.75}
                  strokeLinejoin="round"
                  strokeDasharray={DASH[si]}
                />
                {count <= 24
                  ? s.points.map((p, i) => (
                      <Marker key={`${s.name}-${p.x}-${p.y}`} i={si} x={xAt(i)} y={y(p.y)} />
                    ))
                  : null}
              </g>
            ))}
        {labelIdx.map((i) => (
          <text
            key={i}
            x={xAt(i)}
            y={H - 6}
            textAnchor={
              i === 0 && kind !== "bar"
                ? "start"
                : i === count - 1 && kind !== "bar"
                  ? "end"
                  : "middle"
            }
            fontSize={10}
            style={{ fill: "var(--color-label-secondary)" }}
          >
            {series[0]?.points[i]?.x}
          </text>
        ))}
      </svg>
      {series.length > 1 || kind === "line" ? (
        <ul
          className="flex flex-wrap gap-x-3 gap-y-0.5 text-callout"
          aria-label={t("widgets.chart.series")}
        >
          {series.map((s, i) => (
            <li key={s.name} className="inline-flex items-center gap-1">
              <svg width={22} height={10} aria-hidden="true">
                {kind === "bar" ? (
                  <rect x={4} y={1} width={14} height={8} rx={1} style={{ fill: COLORS[i] }} />
                ) : (
                  <>
                    <line
                      x1={0}
                      x2={22}
                      y1={5}
                      y2={5}
                      style={{ stroke: COLORS[i] }}
                      strokeWidth={1.75}
                      strokeDasharray={DASH[i]}
                    />
                    <Marker i={i} x={11} y={5} />
                  </>
                )}
              </svg>
              {s.name}
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        className="self-start rounded-md px-1 py-0.5 text-callout text-label-secondary hover:bg-fill-quaternary"
        aria-expanded={open}
        aria-controls={tableId}
        onClick={() => setOpen(!open)}
      >
        {open ? t("widgets.chart.hideData") : t("widgets.chart.showData")}
      </button>
      {table}
    </figure>
  );
}
