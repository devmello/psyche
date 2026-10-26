import * as m from "motion/react-m";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { duration, motionSpring, spring } from "../motion/tokens.ts";
import { useReducedMotion } from "../theme/ThemeProvider.tsx";

/**
 * A one-path sparkline, no axes (caption size). Static data (Usage's 7 days) draws in once on
 * `spring.gentle`. Live data (Activity → Now, run-trace §3.6) redraws at most once a second, and
 * each new bucket slides in from the end over `duration.medium`. Reduced motion: no draw, no
 * slide; it redraws in place.
 */

/** Hold a changing series to at most one update per `ms` (the trailing value always lands). */
export function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setShown(value);
      return;
    }
    const timer = setTimeout(() => {
      last.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return shown;
}

export interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  /** Live data: throttled to 1 Hz, new buckets slide in. */
  live?: boolean;
  /** Spoken summary; omit when the row says it (then the sparkline is decorative). */
  label?: string;
  testId?: string;
}

export function Sparkline({
  values,
  width = 40,
  height = 14,
  live = false,
  label,
  testId = "sparkline",
}: SparklineProps): ReactElement {
  const reduce = useReducedMotion();
  const throttled = useThrottled(values, live ? 1000 : 0);
  const shown = live ? throttled : values;
  const max = Math.max(...shown, 0);
  const n = shown.length;
  const pad = 1.5;
  const step = n <= 1 ? 0 : (width - pad * 2) / (n - 1);
  const points = shown.map((v, i) => {
    const x = n <= 1 ? width / 2 : pad + i * step;
    const y = max === 0 ? height - pad : height - pad - (v / max) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const d = points.length > 0 ? `M${points.join(" L")}` : "";
  const last = points.at(-1)?.split(",").map(Number);
  // Each live redraw (a new throttled series) starts one bucket to the right and slides home.
  const redraws = useRef({ shown, n: 0 });
  if (redraws.current.shown !== shown) redraws.current = { shown, n: redraws.current.n + 1 };
  const generation = redraws.current.n;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
      className="shrink-0 overflow-visible text-accent-9"
      data-testid={testId}
    >
      {label ? <title>{label}</title> : null}
      <m.g
        key={live && !reduce ? generation : 0}
        initial={live && !reduce && generation > 0 ? { x: step } : false}
        animate={{ x: 0 }}
        transition={{ duration: duration.medium / 1000, ease: "easeOut" }}
      >
        {d ? (
          <m.path
            d={d}
            fill="none"
            stroke="currentColor"
            strokeOpacity={max === 0 ? 0.3 : 0.6}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={reduce || live ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={motionSpring(spring.gentle)}
          />
        ) : null}
        {last && max > 0 ? <circle cx={last[0]} cy={last[1]} r={1.75} fill="currentColor" /> : null}
      </m.g>
    </svg>
  );
}
