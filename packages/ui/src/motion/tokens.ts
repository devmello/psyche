/**
 * Motion tokens for the 2026 redesign (docs/design/motion.md §2): the single source for
 * `MotionProvider`, the motion helpers and the generated `styles/motion.css`.
 *
 * Springs are designed as SwiftUI-style perceptual `duration` + `bounce` and converted with
 * Apple's formulas (mass 1): stiffness = (2π / duration)², damping = 4π(1 − bounce) / duration.
 * Motion's `visualDuration` is the SwiftUI duration / 1.2 (motion-dom@14.6.0 spring generator).
 */

/** Tween durations in milliseconds (opacity, colour, fills). */
export const duration = {
  instant: 0,
  micro: 100,
  short: 150,
  medium: 220,
  long: 320,
  /** Exits run at this fraction of their enter duration. */
  exitFactor: 0.7,
  /** No loading UI before this (docs/06 §3.0). */
  skeletonDelay: 150,
  /** Per-item list stagger, capped at `staggerMax` items. */
  staggerStep: 20,
  staggerMax: 5,
} as const;

/** Cubic-bezier control points for tweens. */
export const ease = {
  standard: [0.2, 0.8, 0.2, 1],
  enter: [0.16, 1, 0.3, 1],
  exit: [0.4, 0, 1, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

export interface SpringToken {
  /** Perceptual duration in seconds (SwiftUI `duration`). */
  readonly duration: number;
  /** 0 = critically damped; > 0 overshoots. Psyche's ceiling is 0.15. */
  readonly bounce: number;
}

/** Spring presets (docs/design/motion.md §2.3). `smooth` is the global default. */
export const spring = {
  micro: { duration: 0.2, bounce: 0 },
  snappy: { duration: 0.3, bounce: 0.1 },
  smooth: { duration: 0.35, bounce: 0 },
  gentle: { duration: 0.5, bounce: 0 },
  emphasis: { duration: 0.45, bounce: 0.15 },
  interactive: { duration: 0.15, bounce: 0.14 },
} as const satisfies Record<string, SpringToken>;

export type SpringName = keyof typeof spring;

/** Physical parameters for a spring token (mass 1), as in SwiftUI's `Spring(duration:bounce:)`. */
export function springPhysics(s: SpringToken): { stiffness: number; damping: number; mass: 1 } {
  const stiffness = ((2 * Math.PI) / s.duration) ** 2;
  const damping =
    s.bounce >= 0
      ? (4 * Math.PI * (1 - s.bounce)) / s.duration
      : (4 * Math.PI) / (s.duration * (1 + s.bounce));
  return { stiffness, damping, mass: 1 };
}

/** The same spring as a Motion transition (`motion/react`). */
export function motionSpring(s: SpringToken): {
  type: "spring";
  visualDuration: number;
  bounce: number;
} {
  return { type: "spring", visualDuration: s.duration / 1.2, bounce: s.bounce };
}
