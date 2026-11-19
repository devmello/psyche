import { Ban, Check, Clock, X } from "lucide-react";
import { useReducedMotionConfig } from "motion/react";
import * as m from "motion/react-m";
import type { ReactElement } from "react";
import { cn } from "../lib/utils.ts";
import { duration, easeLinear, motionSpring, spring } from "../motion/tokens.ts";
import type { StepState } from "./run-progress.ts";

/** The halo around the current step breathes this many times, then rests (WCAG 2.2.2, under 5 s). */
const HALO_CYCLES = 4;

const seconds = (ms: number): number => ms / 1000;

/**
 * One step's marker on the run rail, a 16 px cell so every label starts on one line:
 * - current: a solid ink dot with a halo that breathes four times and rests (the one moving mark);
 * - done: a quiet check that settles in on `spring.micro`;
 * - waiting: an amber disc with a clock, the only filled marker on the rail;
 * - failed: a red cross; stopped: a muted bar.
 * Reduced motion: no halo motion and no settle; the shapes alone carry the state.
 */
export function RailNode({ state }: { state: StepState }): ReactElement {
  const reduce = useReducedMotionConfig() === true;
  const settle = reduce
    ? {}
    : {
        initial: { scale: 0.6, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        transition: motionSpring(spring.micro),
      };
  return (
    <span
      className="relative flex size-4 shrink-0 items-center justify-center"
      data-testid="rail-node"
      data-state={state}
      aria-hidden="true"
    >
      {state === "current" ? (
        <>
          <m.span
            className="absolute size-4 rounded-full border border-accent-9"
            data-testid="rail-halo"
            {...(reduce
              ? { style: { opacity: 0.35 } }
              : {
                  animate: { scale: [0.5, 1, 0.5], opacity: [0.7, 0.1, 0.7] },
                  transition: {
                    duration: seconds(duration.pulse),
                    repeat: HALO_CYCLES - 1,
                    ease: easeLinear,
                  },
                })}
          />
          <span className="size-2 rounded-full bg-accent-9" />
        </>
      ) : state === "waiting" ? (
        <m.span
          className="flex size-4 items-center justify-center rounded-full bg-approval text-white"
          {...settle}
        >
          <Clock className="size-3" strokeWidth={2} />
        </m.span>
      ) : (
        <m.span
          className={cn(
            "flex size-4 items-center justify-center",
            state === "failed" ? "text-danger-text" : "text-label-tertiary",
          )}
          {...settle}
        >
          {state === "done" ? (
            <Check className="size-3.5" strokeWidth={2} />
          ) : state === "failed" ? (
            <X className="size-3.5" strokeWidth={2} />
          ) : (
            <Ban className="size-3.5" strokeWidth={1.75} />
          )}
        </m.span>
      )}
    </span>
  );
}

/**
 * The line joining a step's marker to the next one. Below a finished step it is ink (the path
 * already taken); below the current or a waiting step it is the quiet hairline (not done yet).
 */
export function RailLine({
  show,
  state,
  inset = false,
  startClass,
}: {
  show: boolean;
  state: StepState;
  inset?: boolean;
  /** Where the line sits, when the row pads its marker (`start-[11.5px]`). */
  startClass?: string;
}): ReactElement | null {
  if (!show) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute top-[22px] -bottom-1 w-px transition-colors duration-(--duration-short) ease-(--ease-standard)",
        startClass ?? (inset ? "start-[15.5px]" : "start-[7.5px]"),
        state === "done" ? "bg-accent-7" : "bg-separator",
      )}
    />
  );
}
