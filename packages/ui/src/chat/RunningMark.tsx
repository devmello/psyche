import { useReducedMotionConfig } from "motion/react";
import * as m from "motion/react-m";
import type { ReactElement } from "react";
import { duration, easeLinear } from "../motion/tokens.ts";

/** Sweeps before it rests: four sweeps of the pulse period stay under 5 s (WCAG 2.2.2). */
const SWEEPS = 4;

/**
 * The compact "the agent is working" mark for rows where the run is not focused (the sidebar's
 * thread rows): a 16 x 4 px track with an ink segment that sweeps across, then rests. Transform
 * only. Reduced motion: the segment is static; the row's tooltip and screen-reader text carry the
 * step.
 */
export function RunningMark({ className }: { className?: string }): ReactElement {
  const reduce = useReducedMotionConfig() === true;
  return (
    <span
      aria-hidden="true"
      data-testid="running-mark"
      className={
        className ??
        "relative block h-1 w-4 shrink-0 overflow-hidden rounded-full bg-fill-secondary"
      }
    >
      <m.span
        className="absolute inset-y-0 start-0 w-1/2 rounded-full bg-accent-9"
        {...(reduce
          ? {}
          : {
              animate: { x: ["0%", "100%", "0%"] },
              transition: {
                duration: duration.pulse / 1000,
                repeat: SWEEPS - 1,
                ease: easeLinear,
              },
            })}
      />
    </span>
  );
}
