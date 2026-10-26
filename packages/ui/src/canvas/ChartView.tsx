import type { ArtifactChart } from "@psyche/protocol";
import { type ReactElement, useId } from "react";
import { t } from "../i18n/core.ts";

/**
 * Renders an `ArtifactChart` (docs/design/chat-experience-2026.md §4.2): the client's own SVG, so
 * the model emits data, never code. Bars, lines, areas and pies over the spec's categories; a
 * legend names every series (colour is never the only cue), and a visually hidden table carries
 * the numbers for screen readers.
 */

/** Mid-lightness hues readable on both themes; series beyond six wrap. */
const COLORS = [
  "oklch(0.66 0.15 260)",
  "oklch(0.7 0.15 150)",
  "oklch(0.72 0.15 55)",
  "oklch(0.66 0.16 320)",
  "oklch(0.7 0.12 200)",
  "oklch(0.7 0.14 95)",
] as const;
const color = (i: number): string => COLORS[i % COLORS.length] as string;

const W = 480;
const H = 260;
const PAD = { l: 44, r: 12, t: 12, b: 32 };

/** A round axis step covering `max` in about 5 ticks. */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

const fmt = (n: number): string =>
  Math.abs(n) >= 1000 ? `${+(n / 1000).toFixed(1)}k` : `${+n.toFixed(2)}`;

function Pie({ chart }: { chart: ArtifactChart }): ReactElement {
  const values = chart.categories.map((_, i) => Math.max(0, chart.series[0]?.values[i] ?? 0));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = 130;
  const cy = H / 2;
  const r = 100;
  let a0 = -Math.PI / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.title ?? t("canvas.chart")}>
      {values.map((v, i) => {
        const a1 = a0 + (v / total) * Math.PI * 2;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const d =
          v / total >= 0.9999
            ? `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`
            : `M${cx} ${cy}L${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)}A${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)}Z`;
        a0 = a1;
        return <path key={chart.categories[i]} d={d} fill={color(i)} stroke="var(--background)" />;
      })}
      {chart.categories.slice(0, 12).map((c, i) => (
        <g key={c} transform={`translate(270 ${24 + i * 18})`}>
          <rect width="10" height="10" rx="2" fill={color(i)} />
          <text x="16" y="9" fontSize="11" fill="currentColor">
            {c} · {Math.round(((values[i] ?? 0) / total) * 100)}%
          </text>
        </g>
      ))}
    </svg>
  );
}

function Axes({ chart }: { chart: ArtifactChart }): ReactElement {
  const stacked = chart.stacked === true && chart.kind !== "line";
  const n = chart.categories.length;
  const all = chart.series.map((s) => s.values.map((v) => v ?? 0));
  const top = stacked
    ? Math.max(0, ...chart.categories.map((_, i) => all.reduce((a, s) => a + (s[i] ?? 0), 0)))
    : Math.max(0, ...all.flat());
  const ticks = niceTicks(top);
  const max = ticks.at(-1) ?? 1;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const band = iw / Math.max(1, n);
  const xAt = (i: number) => PAD.l + band * (i + 0.5);
  const every = Math.ceil(n / 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.title ?? t("canvas.chart")}>
      {ticks.map((v) => (
        <g key={v}>
          <line
            x1={PAD.l}
            x2={W - PAD.r}
            y1={y(v)}
            y2={y(v)}
            stroke="currentColor"
            opacity="0.12"
          />
          <text
            x={PAD.l - 6}
            y={y(v) + 4}
            fontSize="10"
            textAnchor="end"
            fill="currentColor"
            opacity="0.7"
          >
            {fmt(v)}
          </text>
        </g>
      ))}
      {chart.categories.map((c, i) =>
        i % every === 0 ? (
          <text
            key={c}
            x={xAt(i)}
            y={H - 12}
            fontSize="10"
            textAnchor="middle"
            fill="currentColor"
            opacity="0.7"
          >
            {c.length > 10 ? `${c.slice(0, 9)}…` : c}
          </text>
        ) : null,
      )}
      {chart.kind === "bar"
        ? chart.series.map((s, si) => {
            const w = (band * 0.72) / (stacked ? 1 : chart.series.length);
            return s.values.map((v, i) => {
              const base = stacked ? all.slice(0, si).reduce((a, sv) => a + (sv[i] ?? 0), 0) : 0;
              const x = stacked ? xAt(i) - w / 2 : xAt(i) - (w * chart.series.length) / 2 + si * w;
              const h = ((v ?? 0) / max) * ih;
              return (
                <rect
                  key={`${s.name}-${chart.categories[i]}`}
                  x={x}
                  y={y(base + (v ?? 0))}
                  width={Math.max(1, w - 1)}
                  height={Math.max(0, h)}
                  rx="2"
                  fill={color(si)}
                />
              );
            });
          })
        : chart.series.map((s, si) => {
            const pts = s.values.map((v, i) => (v === null ? null : ([xAt(i), y(v)] as const)));
            const segs: Array<Array<readonly [number, number]>> = [[]];
            for (const p of pts) {
              if (p === null) segs.push([]);
              else segs.at(-1)?.push(p);
            }
            return segs
              .filter((g) => g.length > 0)
              .map((g) => {
                const line = g.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]} ${p[1]}`).join("");
                const first = g[0] as readonly [number, number];
                const last = g.at(-1) as readonly [number, number];
                return (
                  <g key={`${s.name}-${first[0]}`}>
                    {chart.kind === "area" ? (
                      <path
                        d={`${line}L${last[0]} ${y(0)}L${first[0]} ${y(0)}Z`}
                        fill={color(si)}
                        opacity="0.25"
                      />
                    ) : null}
                    <path
                      d={line}
                      fill="none"
                      stroke={color(si)}
                      strokeWidth="2"
                      strokeLinejoin="round"
                    />
                    {g.map((p) => (
                      <circle key={p[0]} cx={p[0]} cy={p[1]} r="2.5" fill={color(si)} />
                    ))}
                  </g>
                );
              });
          })}
    </svg>
  );
}

export function ChartView({ chart }: { chart: ArtifactChart }): ReactElement {
  const id = useId();
  return (
    <figure className="flex max-w-xl flex-col gap-2" aria-describedby={`${id}-data`}>
      {chart.title ? (
        <figcaption className="text-headline text-label-primary">{chart.title}</figcaption>
      ) : null}
      <div className="text-label-secondary">
        {chart.kind === "pie" ? <Pie chart={chart} /> : <Axes chart={chart} />}
      </div>
      {chart.kind !== "pie" ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-callout text-label-secondary">
          {chart.series.map((s, i) => (
            <li key={s.name} className="inline-flex items-center gap-1.5">
              <span
                className="size-2.5 rounded-xs"
                style={{ background: color(i) }}
                aria-hidden="true"
              />
              {s.name}
            </li>
          ))}
        </ul>
      ) : null}
      {chart.xLabel || chart.yLabel ? (
        <p className="text-callout text-label-secondary">
          {[chart.yLabel, chart.xLabel].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      <table id={`${id}-data`} className="sr-only">
        <thead>
          <tr>
            <th scope="col">{chart.xLabel ?? t("canvas.chart")}</th>
            {chart.series.map((s) => (
              <th key={s.name} scope="col">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chart.categories.map((c, i) => (
            <tr key={c}>
              <th scope="row">{c}</th>
              {chart.series.map((s) => (
                <td key={s.name}>{s.values[i] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
