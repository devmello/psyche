import { useReducedMotionConfig } from "motion/react";
import type { CSSProperties, ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import { formatStepDuration } from "../steps/LiveDuration.tsx";
import { TICK_MS, useTicker } from "../steps/ticker.ts";
import { axisTicks, type TimeScale } from "./scale.ts";

/**
 * Timeline primitives for the run trace's waterfall (docs/design/run-trace-2026.md §3.3, §3.7):
 * the time axis, a step's bar, the playhead and an idle-gap break. Presentational: T3's
 * `Waterfall` lays rows out and owns the `treegrid` semantics; these are decorative
 * (`aria-hidden`), and each row states its duration in text.
 */

export type BarKind = "thinking" | "tool" | "waiting" | "failed" | "helper";

/** The bar colour per step kind; each is ≥ 3:1 on the canvas in both appearances (SC 1.4.11). */
const KIND: Record<BarKind, string> = {
  thinking: "bg-(--trace-thinking)",
  tool: "bg-(--trace-tool)",
  waiting: "bg-(--trace-waiting)",
  failed: "bg-(--trace-failed)",
  helper: "bg-(--trace-tool) psy-trace-helper",
};

export function TimeAxis({
  scale,
  className,
}: {
  scale: TimeScale;
  className?: string;
}): ReactElement {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative h-5 border-b border-separator text-caption text-label-tertiary",
        className,
      )}
      style={{ width: scale.width }}
    >
      {axisTicks(scale).map((ms) => (
        <span
          key={ms}
          className="absolute top-0 whitespace-nowrap border-s border-separator ps-1 tabular-nums"
          style={{ insetInlineStart: scale.x(scale.start + ms) }}
        >
          {ms === 0 ? "0" : formatStepDuration(ms)}
        </span>
      ))}
      {scale.gaps.map((g) => (
        <GapBreak key={g.from} scale={scale} from={g.from} to={g.to} />
      ))}
    </div>
  );
}

/** A collapsed idle gap: a ⌇ on the axis, its real length on hover (the title). */
export function GapBreak({
  scale,
  from,
  to,
}: {
  scale: TimeScale;
  from: number;
  to: number;
}): ReactElement {
  const x = scale.x(from);
  return (
    <span
      className="absolute top-0 flex h-full items-center justify-center text-label-tertiary"
      style={{ insetInlineStart: x, width: scale.x(to) - x }}
      title={t("design.timeline.gap", { duration: formatStepDuration(to - from) })}
      data-gap=""
    >
      ⌇
    </span>
  );
}

export interface BarSegment {
  /** Waiting on you or queued: hatched; execution: solid. */
  kind: "wait" | "run";
  from: number;
  to?: number | undefined;
}

export interface BarProps {
  scale: TimeScale;
  kind: BarKind;
  start: number;
  /** Absent while running: the bar grows to now on the shared clock. */
  end?: number | undefined;
  /** Optional split into wait and run segments (an approval wait, a rate-limit queue). */
  segments?: readonly BarSegment[];
  /** A fixed "now" for stories and tests. */
  now?: number;
  /** Faint: an earlier failed attempt. */
  faint?: boolean;
  className?: string;
}

/**
 * A step's bar. While running it grows with `transform: scaleX` only (one layout for the whole
 * track, then compositor-only growth on the shared 1 Hz clock), never by changing its width.
 */
export function Bar({
  scale,
  kind,
  start,
  end,
  segments,
  now,
  faint,
  className,
}: BarProps): ReactElement {
  const running = end === undefined;
  const clock = useTicker(running && now === undefined);
  const reduce = useReducedMotionConfig() === true;
  const x0 = scale.x(start);
  const xEnd = scale.x(end ?? now ?? clock);
  // Running bars are laid out to the end of the track once and scaled to their current length.
  const box = running ? Math.max(1, scale.width - x0) : Math.max(2, xEnd - x0);
  const fraction = running ? Math.max(2, xEnd - x0) / box : 1;
  const style: CSSProperties = {
    insetInlineStart: x0,
    width: box,
    transform: running ? `scaleX(${fraction})` : undefined,
    // Between ticks the bar keeps growing at the clock's pace; reduced motion steps once a second.
    transition: running && !reduce ? `transform ${TICK_MS}ms linear` : undefined,
  };
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute top-1/2 flex h-1.5 -translate-y-1/2 origin-left overflow-hidden rounded-[3px] rtl:origin-right",
        faint && "opacity-40",
        className,
      )}
      style={style}
      data-kind={kind}
      data-running={running || undefined}
    >
      {segments && segments.length > 0 ? (
        segments.map((s) => {
          const sx = scale.x(s.from) - x0;
          const sw = Math.max(1, scale.x(s.to ?? end ?? now ?? clock) - scale.x(s.from));
          return (
            <span
              key={s.from}
              className={cn(
                "absolute inset-y-0",
                s.kind === "wait" ? "psy-trace-wait bg-fill-tertiary" : KIND[kind],
              )}
              style={{ insetInlineStart: sx, width: sw }}
              data-segment={s.kind}
            />
          );
        })
      ) : (
        <span className={cn("absolute inset-0", KIND[kind])} />
      )}
    </span>
  );
}

/** The playhead: a 1 px accent line over the track, with a knob on the axis. */
export function Playhead({
  scale,
  at,
  className,
}: {
  scale: TimeScale;
  at: number;
  className?: string;
}): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-y-0 w-px bg-accent-9", className)}
      style={{ insetInlineStart: scale.x(at) }}
      data-playhead=""
    >
      <span className="absolute -top-0.5 -start-1 size-2.5 rounded-full bg-accent-9 ring-2 ring-canvas" />
    </span>
  );
}
