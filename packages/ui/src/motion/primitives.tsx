import { AnimatePresence, type HTMLMotionProps } from "motion/react";
import * as m from "motion/react-m";
import type { ReactElement } from "react";
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
