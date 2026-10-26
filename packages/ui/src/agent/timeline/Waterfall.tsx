// biome-ignore-all lint/a11y/useSemanticElements: a virtualised ARIA treegrid; rows are absolutely positioned flex rows, which <table> can't be
// biome-ignore-all lint/a11y/useFocusableInteractive: rows take a roving tabindex; cells and headers are reached through their row (APG treegrid)
// biome-ignore-all lint/a11y/useKeyWithClickEvents: the treegrid's onKeyDown handles the keyboard for every row (§3.3)
import { ChevronRight } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type RefObject,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { StatusGlyph, stepStatusKind } from "../../components/status.tsx";
import { formatStepDuration, LiveDuration } from "../../components/steps/LiveDuration.tsx";
import type { TimeScale } from "../../components/timeline/scale.ts";
import { Bar, Playhead, TimeAxis } from "../../components/timeline/Timeline.tsx";
import { t } from "../../i18n/core.ts";
import type { MessageId } from "../../i18n/index.ts";
import { formatTime } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";
import { tokens as formatTokens, usd } from "../../screens/settings/UsageSection.tsx";
import type { VisibleRow } from "./model.ts";
import { ROW_HEIGHT, useVirtualRows } from "./virtual.ts";

/**
 * The waterfall (docs/design/run-trace-2026.md §3.3): one row per step on a shared time axis, as
 * a `treegrid` (label, duration, and a decorative bar track). Parallel steps sit under a "{n} at
 * once" bracket, helpers nest and fold, retries are faint segments before the live attempt, waits
 * on you are hatched, idle gaps are ⌇ breaks. Rows are virtualised (2,000 at 60 fps).
 */

export const LABEL_PX = 200;
export const DURATION_PX = 64;

export interface WaterfallProps {
  rows: readonly VisibleRow[];
  scale: TimeScale;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  gridRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The replay playhead (null when following live or showing the end). */
  playhead: number | null;
  /** Dim rows that start after the playhead (click-a-step while replaying). */
  dimAfter: boolean;
  onSeek: (at: number) => void;
  onRange: (range: { from: number; to: number } | null) => void;
  range: { from: number; to: number } | null;
  onZoom: (dir: 1 | -1) => void;
  now: number;
  label: string;
}

function rowLabel(row: VisibleRow): string {
  return row.type === "group" ? t("agent.timeline.group", { n: row.children.length }) : row.label;
}

function tooltip(row: VisibleRow, now: number): string {
  const start = formatTime(new Date(row.start).toISOString());
  const duration = formatStepDuration((row.end ?? now) - row.start);
  if (row.rollup.tokens !== null && row.rollup.tokens > 0) {
    return t("agent.timeline.tooltipUsage", {
      start,
      duration,
      tokens: formatTokens(row.rollup.tokens),
      cost: row.rollup.costUsd === null ? t("agent.timeline.unknown") : usd(row.rollup.costUsd),
    });
  }
  return t("agent.timeline.tooltip", { start, duration });
}

export function Waterfall({
  rows,
  scale,
  selectedId,
  onSelect,
  onToggle,
  onKeyDown,
  gridRef,
  scrollRef,
  playhead,
  dimAfter,
  onSeek,
  onRange,
  range,
  onZoom,
  now,
  label,
}: WaterfallProps): ReactElement {
  const { start, end } = useVirtualRows(scrollRef, rows.length);
  const trackPx = scale.width;
  const drag = useRef<{ x0: number; moved: boolean } | null>(null);
  const [selecting, setSelecting] = useState<{ x0: number; x1: number } | null>(null);
  const selectedIndex = rows.findIndex((r) => r.id === selectedId);
  const focusIndex = selectedIndex === -1 ? 0 : selectedIndex;

  const trackX = (e: PointerEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return Math.min(trackPx, Math.max(0, e.clientX - box.left));
  };
  const onAxisDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const x = trackX(e);
    drag.current = { x0: x, moved: false };
    setSelecting({ x0: x, x1: x });
  };
  const onAxisMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current === null) return;
    const x = trackX(e);
    if (Math.abs(x - drag.current.x0) > 4) drag.current.moved = true;
    setSelecting({ x0: drag.current.x0, x1: x });
  };
  const onAxisUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setSelecting(null);
    if (d === null) return;
    const x = trackX(e);
    if (d.moved) {
      const a = scale.at(Math.min(d.x0, x));
      const b = scale.at(Math.max(d.x0, x));
      onRange(b > a ? { from: a, to: b } : null);
    } else onSeek(scale.at(x));
  };
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    // A trackpad pinch arrives as a ctrl+wheel in Chromium.
    if (!e.ctrlKey) return;
    e.preventDefault();
    onZoom(e.deltaY < 0 ? 1 : -1);
  };

  const sticky = "sticky z-10 bg-canvas";
  // The selection fill over the canvas, opaque so bars scroll under the sticky label columns.
  const selectedFill = "bg-[color-mix(in_oklch,var(--canvas),var(--accent-9)_14%)]";
  return (
    <div
      ref={gridRef}
      role="treegrid"
      aria-label={label}
      aria-rowcount={rows.length + 1}
      aria-colcount={3}
      aria-multiselectable={false}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={onKeyDown}
      data-testid="waterfall"
    >
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onWheel={onWheel}>
        <div style={{ width: LABEL_PX + DURATION_PX + trackPx + 16 }}>
          <div
            role="row"
            aria-rowindex={1}
            className="sticky top-0 z-20 flex h-6 items-end bg-canvas"
          >
            <div
              role="columnheader"
              className={cn(sticky, "start-0 ps-2 text-caption text-label-tertiary")}
              style={{ width: LABEL_PX }}
            >
              {t("agent.timeline.col.step")}
            </div>
            <div
              role="columnheader"
              className={cn(sticky, "pe-2 text-end text-caption text-label-tertiary")}
              style={{ width: DURATION_PX, insetInlineStart: LABEL_PX }}
            >
              {t("agent.timeline.col.duration")}
            </div>
            <div
              role="columnheader"
              className="relative select-none"
              style={{ width: trackPx }}
              onPointerDown={onAxisDown}
              onPointerMove={onAxisMove}
              onPointerUp={onAxisUp}
              onPointerCancel={() => {
                drag.current = null;
                setSelecting(null);
              }}
              data-testid="waterfall-axis"
            >
              <span className="sr-only">{t("agent.timeline.col.time")}</span>
              <TimeAxis scale={scale} />
              {selecting && Math.abs(selecting.x1 - selecting.x0) > 4 ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 bg-accent-a4"
                  style={{
                    insetInlineStart: Math.min(selecting.x0, selecting.x1),
                    width: Math.abs(selecting.x1 - selecting.x0),
                  }}
                />
              ) : null}
            </div>
          </div>
          <div role="rowgroup" className="relative" style={{ height: rows.length * ROW_HEIGHT }}>
            {/* Decorative overlays across every row: gap breaks, the range and the playhead. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0"
              style={{ insetInlineStart: LABEL_PX + DURATION_PX, width: trackPx }}
            >
              {scale.gaps.map((g) => (
                <span
                  key={g.from}
                  className="absolute inset-y-0 border-x border-dashed border-separator bg-fill-quaternary"
                  style={{
                    insetInlineStart: scale.x(g.from),
                    width: scale.x(g.to) - scale.x(g.from),
                  }}
                />
              ))}
              {range ? (
                <span
                  className="absolute inset-y-0 bg-accent-a3"
                  style={{
                    insetInlineStart: scale.x(range.from),
                    width: Math.max(1, scale.x(range.to) - scale.x(range.from)),
                  }}
                  data-range=""
                />
              ) : null}
              {playhead !== null ? <Playhead scale={scale} at={playhead} /> : null}
            </div>
            {rows.slice(start, end).map((row, i) => {
              const index = start + i;
              const selected = row.id === selectedId;
              const dim = dimAfter && playhead !== null && row.start > playhead;
              const name = rowLabel(row);
              return (
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={index + 2}
                  aria-level={row.level + 1}
                  aria-posinset={row.posInSet}
                  aria-setsize={row.setSize}
                  aria-selected={selected}
                  {...(row.foldable ? { "aria-expanded": row.expanded } : {})}
                  tabIndex={index === focusIndex ? 0 : -1}
                  data-row-id={row.id}
                  data-status={row.status}
                  className={cn(
                    "group/row absolute inset-x-0 flex items-center outline-none",
                    "hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    selected && "bg-accent-a4 hover:bg-accent-a4",
                    dim && "opacity-40",
                  )}
                  style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                  onClick={() => onSelect(row.id)}
                >
                  <div
                    role="gridcell"
                    className={cn(
                      sticky,
                      "start-0 flex h-full min-w-0 items-center gap-1.5 pe-2",
                      selected
                        ? selectedFill
                        : "group-hover/row:bg-[color-mix(in_oklch,var(--canvas),var(--label-primary)_3%)]",
                    )}
                    style={{
                      width: LABEL_PX,
                      paddingInlineStart: 8 + row.level * 14,
                    }}
                  >
                    {row.foldable ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={t(
                          row.expanded ? "agent.timeline.fold" : "agent.timeline.unfold",
                          { label: name },
                        )}
                        className="-ms-1 flex size-4 shrink-0 items-center justify-center rounded-xs text-label-tertiary hover:text-label-primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggle(row.id);
                        }}
                      >
                        <ChevronRight
                          aria-hidden="true"
                          className={cn(
                            "size-3.5 transition-transform rtl:rotate-180",
                            row.expanded && "rotate-90 rtl:rotate-90",
                          )}
                        />
                      </button>
                    ) : (
                      <span className="size-3 shrink-0" />
                    )}
                    {row.type === "step" ? (
                      <StatusGlyph
                        status={
                          row.step?.kind === "thinking" && row.status === "ok"
                            ? "thinking"
                            : (row.step?.attempt ?? 1) > 1 && row.status === "running"
                              ? "retried"
                              : stepStatusKind(row.status)
                        }
                        label={t(`agent.timeline.status.${row.status}` as MessageId)}
                        className="size-3.5 shrink-0"
                      />
                    ) : null}
                    <span
                      className={cn(
                        "min-w-0 truncate text-body",
                        row.type === "group" && "text-label-secondary",
                        row.status === "failed" && "text-danger-text",
                      )}
                    >
                      {name}
                    </span>
                  </div>
                  <div
                    role="gridcell"
                    className={cn(
                      sticky,
                      "flex h-full items-center justify-end pe-2 text-callout text-label-secondary tabular-nums",
                      selected
                        ? selectedFill
                        : "group-hover/row:bg-[color-mix(in_oklch,var(--canvas),var(--label-primary)_3%)]",
                    )}
                    style={{
                      width: DURATION_PX,
                      insetInlineStart: LABEL_PX,
                    }}
                  >
                    <LiveDuration
                      startedAt={row.start}
                      endedAt={row.end ?? undefined}
                      {...(playhead !== null ? { now: playhead } : { now })}
                    />
                  </div>
                  <div
                    role="gridcell"
                    className="relative h-full"
                    style={{ width: trackPx }}
                    title={tooltip(row, playhead ?? now)}
                  >
                    {row.type === "group" ? (
                      <span
                        aria-hidden="true"
                        className="absolute top-1/2 h-2 -translate-y-1/2 rounded-t-[2px] border-x border-t border-label-tertiary"
                        style={{
                          insetInlineStart: scale.x(row.start),
                          width: Math.max(
                            4,
                            scale.x(row.end ?? playhead ?? now) - scale.x(row.start),
                          ),
                        }}
                        data-bracket=""
                      />
                    ) : (
                      <>
                        {row.attempts.map((a) => (
                          <Bar
                            key={a.start}
                            scale={scale}
                            kind={a.failed ? "failed" : row.barKind}
                            start={a.start}
                            end={a.end ?? row.start}
                            faint
                          />
                        ))}
                        <Bar
                          scale={scale}
                          kind={row.barKind}
                          start={row.start}
                          end={row.end ?? undefined}
                          {...(row.segments ? { segments: row.segments } : {})}
                          {...(playhead !== null ? { now: playhead } : {})}
                        />
                        {(row.step?.attempt ?? 1) > 1 ? (
                          <span
                            className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-fill-secondary px-1.5 text-subheadline text-label-secondary"
                            style={{ insetInlineStart: scale.x(row.end ?? playhead ?? now) + 6 }}
                          >
                            {t("agent.timeline.attempt", { n: row.step?.attempt ?? 1 })}
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
