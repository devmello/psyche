import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { formatCountdown } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";
import { useTicker } from "./ticker.ts";

/**
 * A step's time (docs/design/run-trace-2026.md §3.2): while running, the elapsed time as `m:ss`
 * ticking once a second on the shared clock; once ended, a rounded duration ("3 s",
 * "1 min 4 s", "1 h 5 min"). Tabular numbers, never animated (§3.7), and never announced: the
 * live region speaks step starts and outcomes, not ticks.
 */

/** Rounded duration for a finished step: seconds under a minute, then minutes and seconds. */
export function formatStepDuration(ms: number): string {
  if (ms < 1000) return t("time.ms", { n: Math.max(0, Math.round(ms)) });
  const s = Math.round(ms / 1000);
  if (s < 60) return t("time.s", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60)
    return s % 60 === 0 ? t("time.min", { n: m }) : t("design.duration.minS", { m, s: s % 60 });
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? t("time.h", { h }) : t("time.hMin", { h, m: m % 60 });
}

/** Elapsed time for a running step: `0:07`, `1:12`, `1:02:09`. */
export function formatElapsed(ms: number): string {
  return formatCountdown(ms);
}

export interface LiveDurationProps {
  /** Epoch ms the step started. */
  startedAt: number;
  /** Epoch ms it ended; absent while running. */
  endedAt?: number | undefined;
  /** A fixed "now" for stories and tests (the shared clock otherwise). */
  now?: number;
  className?: string;
}

export function LiveDuration({
  startedAt,
  endedAt,
  now,
  className,
}: LiveDurationProps): ReactElement {
  const running = endedAt === undefined;
  const clock = useTicker(running && now === undefined);
  const end = endedAt ?? now ?? clock;
  const ms = Math.max(0, end - startedAt);
  return (
    <span
      className={cn("shrink-0 tabular-nums", className)}
      data-running={running || undefined}
      aria-hidden={running || undefined}
    >
      {running ? formatElapsed(ms) : formatStepDuration(ms)}
    </span>
  );
}
