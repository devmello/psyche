import { AnimatePresence, type HTMLMotionProps, useReducedMotionConfig } from "motion/react";
import * as m from "motion/react-m";
import type { ReactElement, ReactNode } from "react";
import { duration, ease, motionSpring, spring } from "./tokens.ts";

/**
 * Enter/exit helpers for content (docs/design/motion.md §4.1): fade plus an 8 px rise on
 * `spring.snappy`, exits fade without moving. Under reduced motion `MotionConfig` drops the rise
 * and keeps the fade.
 */

const seconds = (ms: number) => ms / 1000;

export const fadeRise = {
  initial: { opacity: 0, y: 8 },
  animate: {
    opacity: 1,
    y: 0,
    transition: {
      y: motionSpring(spring.snappy),
      opacity: { duration: seconds(duration.medium), ease: [...ease.enter] },
    },
  },
  exit: {
    opacity: 0,
    transition: {
      duration: seconds(duration.short * duration.exitFactor),
      ease: [...ease.exit],
    },
  },
} as const;

export const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: seconds(duration.short) } },
  exit: { opacity: 0, transition: { duration: seconds(duration.short * duration.exitFactor) } },
} as const;

/** A block that fades and rises in, and fades out inside a `Presence`. */
export function FadeIn({
  still = false,
  ...props
}: HTMLMotionProps<"div"> & {
  /** Fade only, never move (approval cards: docs/06 §3.3). */
  still?: boolean;
}): ReactElement {
  return <m.div {...(still ? fade : fadeRise)} {...props} />;
}

/** A list item: like `FadeIn`, with an optional capped stagger index (§4.1). */
export function ListItem({
  index = 0,
  ...props
}: HTMLMotionProps<"li"> & { index?: number }): ReactElement {
  const delay = seconds(Math.min(index, duration.staggerMax) * duration.staggerStep);
  return (
    <m.li
      initial={fadeRise.initial}
      animate={{ ...fadeRise.animate, transition: { ...fadeRise.animate.transition, delay } }}
      exit={fadeRise.exit}
      {...props}
    />
  );
}

/** Exit animations for unmounting children; `popLayout` lets siblings close the gap. */
export const Presence = AnimatePresence;

/**
 * Expanding detail (smoothness-2026 C10): height and opacity on `spring.smooth`, exit at the
 * short fade. Reduced motion keeps the opacity fade and drops the height. `children` mount only
 * while `open`.
 */
export function Disclosure({
  open,
  children,
  ...props
}: Omit<HTMLMotionProps<"div">, "children"> & {
  open: boolean;
  children?: ReactNode;
}): ReactElement {
  const reduce = useReducedMotionConfig() === true;
  const out = seconds(duration.short * duration.exitFactor);
  return (
    <Presence initial={false}>
      {open ? (
        <m.div
          key="disclosure"
          initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
          animate={{
            ...(reduce ? {} : { height: "auto" }),
            opacity: 1,
            transition: {
              height: motionSpring(spring.smooth),
              opacity: { duration: seconds(duration.short), ease: [...ease.standard] },
            },
          }}
          exit={{
            ...(reduce ? {} : { height: 0 }),
            opacity: 0,
            transition: {
              height: motionSpring(spring.smooth),
              opacity: { duration: out, ease: [...ease.exit] },
            },
          }}
          style={{ overflow: "hidden" }}
          {...props}
        >
          {children}
        </m.div>
      ) : null}
    </Presence>
  );
}

/** The working pulse runs this many cycles, then rests at full opacity (under 5 s, WCAG 2.2.2). */
const PULSE_CYCLES = 4;
const PULSE_KEYFRAMES = Array.from({ length: PULSE_CYCLES * 2 + 1 }, (_, i) =>
  i % 2 === 0 ? 1 : 0.4,
);

/**
 * The one working pulse (motion.md §4.6): a dot easing 100% → 40% → 100% on `duration.pulse`
 * (a full cycle), linear, ending at 100%. Static under reduced motion, where the text says it.
 */
export function WorkingPulse({ className }: { className?: string }): ReactElement {
  const reduce = useReducedMotionConfig() === true;
  return (
    <m.span
      className={className ?? "size-2 shrink-0 rounded-full bg-label-secondary"}
      aria-hidden="true"
      data-testid="working-pulse"
      {...(reduce
        ? {}
        : {
            animate: { opacity: PULSE_KEYFRAMES },
            transition: { duration: seconds(duration.pulse) * PULSE_CYCLES, ease: "linear" },
          })}
    />
  );
}
