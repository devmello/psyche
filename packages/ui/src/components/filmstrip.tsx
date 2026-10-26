import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { formatTime } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";

/**
 * The frames Psyche saw during a task (docs/design/run-trace-2026.md §3.4): 48 × 30 thumbnails in
 * time order, lazy-loaded, the current one outlined in the accent. A toolbar of buttons; the
 * caller moves the scrubber and the frame viewer when one is chosen.
 */

export interface FilmstripFrame {
  seq: number;
  /** ISO time the frame was taken. */
  at: string;
  /** Thumbnail URL (`runs.frame` at thumb size); absent until loaded, drawn as a placeholder. */
  src?: string;
}

export interface FilmstripProps {
  frames: readonly FilmstripFrame[];
  current?: number;
  onSelect?: (seq: number) => void;
  className?: string;
}

export function Filmstrip({ frames, current, onSelect, className }: FilmstripProps): ReactElement {
  return (
    <div
      role="toolbar"
      aria-label={t("design.filmstrip.label")}
      className={cn("flex gap-1 overflow-x-auto py-1", className)}
    >
      {frames.map((f) => {
        const selected = f.seq === current;
        return (
          <button
            key={f.seq}
            type="button"
            aria-pressed={selected}
            aria-label={t("design.filmstrip.frame", { time: formatTime(f.at) })}
            onClick={() => onSelect?.(f.seq)}
            className={cn(
              "h-[30px] w-12 shrink-0 overflow-hidden rounded-xs bg-fill-tertiary outline-none ring-offset-1 ring-offset-canvas focus-visible:ring-2 focus-visible:ring-ring",
              selected && "ring-2 ring-accent-9",
            )}
            data-seq={f.seq}
          >
            {f.src ? (
              <img src={f.src} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
