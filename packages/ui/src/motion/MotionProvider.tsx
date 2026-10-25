import { LazyMotion, MotionConfig } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { motionSpring, spring } from "./tokens.ts";

const loadFeatures = () => import("./features.ts").then((m) => m.default);
const loadLayoutFeatures = () => import("./layout-features.ts").then((m) => m.default);

export interface MotionProviderProps {
  children?: ReactNode;
  /**
   * The resolved reduced-motion preference (OS or Appearance switch). When true, Motion drops
   * transform and layout animations and keeps opacity (docs/design/motion.md §7).
   */
  reduce?: boolean;
}

/**
 * Motion for the whole app (docs/design/motion.md §6): `LazyMotion` with `domAnimation` loaded
 * asynchronously, `strict` so a full `motion.*` component can't sneak the whole bundle back in,
 * and `spring.smooth` as the default transition instead of Motion's bouncy defaults.
 */
export function MotionProvider({ children, reduce }: MotionProviderProps): ReactElement {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig
        reducedMotion={reduce === undefined ? "user" : reduce ? "always" : "never"}
        transition={motionSpring(spring.smooth)}
      >
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}

/**
 * Adds layout animations and `layoutId` to a subtree (the chat column, the sidebar). Kept out of
 * the default features so only the chunks that use them pay for them.
 */
export function LayoutMotion({ children }: { children?: ReactNode }): ReactElement {
  return (
    <LazyMotion features={loadLayoutFeatures} strict>
      {children}
    </LazyMotion>
  );
}
