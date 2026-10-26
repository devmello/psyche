import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { formatElapsed } from "../../components/steps/LiveDuration.tsx";
import { type Gap, timeScale } from "../../components/timeline/scale.ts";
import { Button } from "../../components/ui/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import type { ReplayClock } from "./clock.ts";
import { REPLAY_SPEEDS, type ReplaySpeed } from "./replay.ts";

/**
 * The replay scrubber (docs/design/run-trace-2026.md §3.5): a time axis with a playhead, failure
 * and approval markers, play at 1× / 4× / 16× with "Skip waits" and "Stop at failures", event
 * stepping, and Live / Back to live while the task is still running. The playhead follows the
 * pointer 1:1 (no spring). The track is a `slider`.
 */

export interface ScrubberMarker {
  at: number;
  kind: "failed" | "approval";
}

export interface ScrubberProps {
  start: number;
  end: number;
  /** Where the playhead is. */
  at: number;
  /** The live clock: thumb, fill and time follow it by direct DOM writes while playing. */
  clock?: ReplayClock;
  gaps: readonly Gap[];
  markers: readonly ScrubberMarker[];
  /** The task is running and the view follows it (the Live pill). */
  live: boolean;
  /** The task is running but the playhead was dragged back. */
  behindLive: boolean;
  playing: boolean;
  speed: ReplaySpeed;
  skipWaits: boolean;
  stopAtFailures: boolean;
  onSeek: (at: number) => void;
  onPlayPause: () => void;
  onSpeed: (speed: ReplaySpeed) => void;
  onSkipWaits: (on: boolean) => void;
  onStopAtFailures: (on: boolean) => void;
  onBackToLive: () => void;
  onPrevEvent: () => void;
  onNextEvent: () => void;
  /** The frames strip, under the track. */
  frames?: ReactNode;
}

export function Scrubber({
  start,
  end,
  at,
  clock,
  gaps,
  markers,
  live,
  behindLive,
  playing,
  speed,
  skipWaits,
  stopAtFailures,
  onSeek,
  onPlayPause,
  onSpeed,
  onSkipWaits,
  onStopAtFailures,
  onBackToLive,
  onPrevEvent,
  onNextEvent,
  frames,
}: ScrubberProps): ReactElement {
  const id = useId();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    const el = trackRef.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => setWidth(Math.max(40, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(40, el.clientWidth || 320));
    return () => ro.disconnect();
  }, []);
  const scale = timeScale({ start, end: Math.max(end, start + 1), width, gaps });
  const dragging = useRef(false);
  const seekTo = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = Math.min(width, Math.max(0, e.clientX - box.left));
    onSeek(scale.at(document.dir === "rtl" ? width - x : x));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const big = (end - start) / 10;
    const delta: Record<string, number> = {
      ArrowLeft: -1000,
      ArrowDown: -1000,
      ArrowRight: 1000,
      ArrowUp: 1000,
      PageDown: -big,
      PageUp: big,
    };
    if (e.key === "Home") onSeek(start);
    else if (e.key === "End") onSeek(end);
    else if (delta[e.key] !== undefined)
      onSeek(Math.min(end, Math.max(start, at + (delta[e.key] as number))));
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const fillRef = useRef<HTMLSpanElement | null>(null);
  const thumbRef = useRef<HTMLSpanElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const total = formatElapsed(end - start);
  useEffect(() => {
    if (!clock) return;
    return clock.subscribe((now) => {
      const x = scale.x(now);
      if (fillRef.current) fillRef.current.style.width = `${x}px`;
      if (thumbRef.current) thumbRef.current.style.insetInlineStart = `${x}px`;
      if (labelRef.current)
        labelRef.current.textContent = t("agent.timeline.scrubber.value", {
          at: formatElapsed(Math.max(0, now - start)),
          total,
        });
      trackRef.current?.setAttribute(
        "aria-valuenow",
        String(Math.max(0, Math.round((now - start) / 1000))),
      );
    });
  }, [clock, scale, start, total]);
  const position = formatElapsed(Math.max(0, at - start));
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar-like group of controls, not a form fieldset
    <div
      role="group"
      aria-label={t("agent.timeline.scrubber.controls")}
      className="flex flex-col gap-1.5 border-t border-separator pt-2"
      data-testid="scrubber"
    >
      <div className="flex items-center gap-1.5">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t("agent.timeline.prevEvent")}
          onClick={onPrevEvent}
        >
          <ChevronLeft aria-hidden="true" className="rtl:rotate-180" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={playing ? t("agent.timeline.pauseReplay") : t("agent.timeline.play")}
          aria-keyshortcuts="Space"
          onClick={onPlayPause}
        >
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t("agent.timeline.nextEvent")}
          onClick={onNextEvent}
        >
          <ChevronRight aria-hidden="true" className="rtl:rotate-180" />
        </Button>
        {/* biome-ignore lint/a11y/useSemanticElements: a segmented control of pressed buttons */}
        <div role="group" aria-label={t("agent.timeline.speed")} className="flex">
          {REPLAY_SPEEDS.map((s) => (
            <Button
              key={s}
              size="xs"
              variant={speed === s ? "secondary" : "ghost"}
              aria-pressed={speed === s}
              onClick={() => onSpeed(s)}
              className="tabular-nums"
            >
              {t("agent.timeline.speedValue", { n: s })}
            </Button>
          ))}
        </div>
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label={t("agent.timeline.scrubber.label")}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, Math.round((end - start) / 1000))}
          aria-valuenow={Math.max(0, Math.round((at - start) / 1000))}
          aria-valuetext={t("agent.timeline.scrubber.value", { at: position, total })}
          className="relative mx-1 h-6 min-w-16 flex-1 touch-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onKeyDown={onKey}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            dragging.current = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            seekTo(e);
          }}
          onPointerMove={(e) => {
            if (dragging.current) seekTo(e);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
        >
          <span
            aria-hidden="true"
            className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-fill-secondary"
          />
          <span
            aria-hidden="true"
            ref={fillRef}
            className="absolute start-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent-9"
            style={{ width: scale.x(at) }}
          />
          {gaps.map((g) => (
            <span
              key={g.from}
              aria-hidden="true"
              className="absolute top-1/2 h-2 -translate-y-1/2 border-x border-label-tertiary"
              style={{
                insetInlineStart: scale.x(g.from),
                width: Math.max(2, scale.x(g.to) - scale.x(g.from)),
              }}
            />
          ))}
          {markers.map((m) => (
            <span
              key={`${m.kind}-${m.at}`}
              aria-hidden="true"
              className={cn(
                "absolute top-0 h-1.5 w-0.5 rounded-full",
                m.kind === "failed" ? "bg-danger" : "bg-approval",
              )}
              style={{ insetInlineStart: scale.x(m.at) }}
              data-marker={m.kind}
            />
          ))}
          <span
            ref={thumbRef}
            aria-hidden="true"
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-9 ring-2 ring-canvas rtl:translate-x-1/2"
            style={{ insetInlineStart: scale.x(at) }}
            data-playhead=""
          />
        </div>
        <span ref={labelRef} className="shrink-0 text-callout text-label-secondary tabular-nums">
          {t("agent.timeline.scrubber.value", { at: position, total })}
        </span>
        {live ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-fill-secondary px-2 text-subheadline text-label-primary">
            {t("agent.timeline.live")}
          </span>
        ) : behindLive ? (
          <Button size="xs" variant="outline" onClick={onBackToLive} className="shrink-0">
            {t("agent.timeline.backToLive")}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-callout text-label-secondary">
        <span className="flex items-center gap-1.5">
          <Checkbox
            id={`${id}-skip`}
            checked={skipWaits}
            onCheckedChange={(v) => onSkipWaits(v === true)}
          />
          <label htmlFor={`${id}-skip`}>{t("agent.timeline.skipWaits")}</label>
        </span>
        <span className="flex items-center gap-1.5">
          <Checkbox
            id={`${id}-stop`}
            checked={stopAtFailures}
            onCheckedChange={(v) => onStopAtFailures(v === true)}
          />
          <label htmlFor={`${id}-stop`}>{t("agent.timeline.stopAtFailures")}</label>
        </span>
      </div>
      {frames}
    </div>
  );
}
