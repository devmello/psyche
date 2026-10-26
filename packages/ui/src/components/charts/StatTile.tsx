import type { MouseEvent, ReactElement, ReactNode } from "react";
import { Card } from "../../blocks/card.tsx";
import type { I18n } from "../../i18n/core.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { cn } from "../../lib/utils.ts";
import { Sparkline } from "../sparkline.tsx";
import { computeDelta, type Delta, sparklineEligible } from "./model.ts";

export interface StatTileProps {
  /** Short noun for the number ("Tasks done"); may wrap to two lines. */
  label: string;
  value: number;
  /** The previous period's value. Omit to show no delta (all-time); null or 0 shows "—". */
  previous?: number | null;
  /** Names the comparison in the delta words: "last month". */
  periodLabel?: string;
  /** Daily counts for the sparkline; drawn only with at least two non-zero points. */
  spark?: readonly number[];
  /** A line under the delta ("98% ok · 4 failed"); may hold its own links. */
  subline?: ReactNode;
  /** The tile is a link when `href` is set, a button when `onClick` is. */
  href?: string;
  /** Receives the click so a link can navigate in-app (`preventDefault`) and keep its `href`. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  className?: string;
  testId?: string;
}

const ARROW = { up: "↑", down: "↓", flat: "→", none: "—" } as const;

/** The delta in words, e.g. "12 more (8%) than last month". Never coloured red or green. */
export function deltaText(i18n: I18n, delta: Delta, period: string): string {
  switch (delta.kind) {
    case "none":
      return i18n.t("charts.delta.none");
    case "flat":
      return i18n.t("charts.delta.flat", { period });
    default:
      return i18n.t(delta.kind === "up" ? "charts.delta.up" : "charts.delta.down", {
        period,
        n: i18n.t("charts.delta.fraction", {
          n: i18n.number(delta.amount),
          pct: i18n.percent(delta.fraction, { maximumFractionDigits: 0 }),
        }),
      });
  }
}

/**
 * A summary tile (agent-overview-2026 §5.4): label, a big tabular number, an optional sparkline,
 * a delta chip (arrow glyph plus words) and a subline. As a link its accessible name carries the
 * number and the delta. Chrome is the shared `Card`.
 */
export function StatTile({
  label,
  value,
  previous,
  periodLabel = "",
  spark,
  subline,
  href,
  onClick,
  className,
  testId = "stat-tile",
}: StatTileProps): ReactElement {
  const i18n = useI18n();
  const delta = computeDelta(value, previous);
  const showDelta = previous !== undefined;
  const words = showDelta ? deltaText(i18n, delta, periodLabel) : "";
  const number = i18n.number(value);
  const name = i18n.t("charts.tile.name", { label, value: number, delta: words }).trim();
  const body = (
    <>
      <span className="label-fit cjk-wrap block text-caption text-label-secondary">{label}</span>
      <span className="block text-title-1 text-label-primary tabular-nums">{number}</span>
    </>
  );
  const stretched =
    "after:absolute after:inset-0 after:rounded-lg after:content-[''] hover:after:bg-fill-quaternary focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring";
  return (
    <Card
      label={label}
      animate={false}
      className={cn("relative my-0 min-h-24 p-5", className)}
      data-testid={testId}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-start">
          {href !== undefined ? (
            <a href={href} onClick={onClick} aria-label={name} className={stretched}>
              {body}
            </a>
          ) : onClick !== undefined ? (
            <button
              type="button"
              onClick={onClick}
              aria-label={name}
              className={cn("block text-start", stretched)}
            >
              {body}
            </button>
          ) : (
            <div>{body}</div>
          )}
        </div>
        {sparklineEligible(spark) ? (
          <Sparkline values={spark ?? []} width={64} height={24} testId="stat-tile-spark" />
        ) : null}
      </div>
      {showDelta || subline !== undefined ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-caption text-label-secondary">
          {showDelta ? (
            <span data-testid="stat-tile-delta" data-delta={delta.kind}>
              <span aria-hidden="true">{ARROW[delta.kind]}</span>{" "}
              {delta.kind === "none" ? <span className="sr-only">{words}</span> : words}
            </span>
          ) : null}
          {subline !== undefined ? <span className="relative z-10">{subline}</span> : null}
        </div>
      ) : null}
    </Card>
  );
}
