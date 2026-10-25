import { AnimatePresence, type HTMLMotionProps } from "motion/react";
import * as m from "motion/react-m";
import { type ReactElement, type ReactNode, ViewTransition } from "react";
import { LayoutMotion } from "../motion/MotionProvider.tsx";
import { duration, ease, motionSpring, spring } from "../motion/tokens.ts";
import { useReducedMotion } from "../theme/ThemeProvider.tsx";

/**
 * The shell's movement (docs/design/motion.md §4.3–§4.5): the sidebar slides away on ⌘B, panes
 * slide in from the end edge, the content column reflows by FLIP (never by animating its width),
 * the selection pill moves between rows, and routes crossfade. Each has its reduced-motion form
 * (§7): reflow is instant and the sidebar or pane fades for 150 ms.
 */

const seconds = (ms: number) => ms / 1000;
const fadeShort = { duration: seconds(duration.short), ease: [...ease.standard] as const };

/** Layout features for the shell subtree (sidebar pill, column reflow). */
export function ShellMotion({ children }: { children?: ReactNode }): ReactElement {
  return <LayoutMotion>{children}</LayoutMotion>;
}

/**
 * The sidebar column: present or collapsed. It translates −100% on `spring.gentle` while the
 * content beside it reflows; `popLayout` takes the leaving sidebar out of the flow at once.
 */
export function SidebarPresence({
  open,
  children,
  className,
  style,
  testId,
}: {
  open: boolean;
  children?: ReactNode;
  className?: string;
  style?: HTMLMotionProps<"div">["style"];
  testId?: string;
}): ReactElement {
  const reduce = useReducedMotion();
  const hidden = reduce ? { opacity: 0 } : { x: "-100%" };
  const shown = reduce ? { opacity: 1 } : { x: 0 };
  const transition = reduce ? fadeShort : motionSpring(spring.gentle);
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {open ? (
        <m.div
          key="sidebar"
          className={className}
          style={style}
          data-testid={testId}
          initial={hidden}
          animate={shown}
          exit={hidden}
          transition={transition}
        >
          {children}
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * A column that reflows when its neighbours come and go (sidebar, panes): it animates its
 * position from where it was (FLIP), never its width. Reduced motion reflows instantly.
 */
export function ReflowColumn({
  children,
  ...props
}: Omit<HTMLMotionProps<"main">, "layout">): ReactElement {
  const reduce = useReducedMotion();
  return (
    <m.main layout={reduce ? false : "position"} transition={motionSpring(spring.smooth)} {...props}>
      {children}
    </m.main>
  );
}

/**
 * Panes beside the chat: the pane column enters from its end edge on `spring.smooth` and leaves
 * the same way. Reduced motion fades it for 150 ms.
 */
export function PanePresence({
  children,
  className,
  style,
  testId,
}: {
  /** The pane column, or `null` when no pane is open. */
  children?: ReactNode;
  className?: string;
  style?: HTMLMotionProps<"div">["style"];
  testId?: string;
}): ReactElement {
  const reduce = useReducedMotion();
  const away = reduce ? { opacity: 0 } : { x: "100%" };
  const here = reduce ? { opacity: 1 } : { x: 0 };
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {children ? (
        <m.div
          key="panes"
          className={className}
          style={style}
          data-testid={testId}
          initial={away}
          animate={here}
          exit={away}
          transition={reduce ? fadeShort : motionSpring(spring.smooth)}
        >
          {children}
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * The selection highlight behind the current sidebar row (redesign §5.1): accent-tinted while
 * the window is key and gray when it isn't (`bg-selection`). It moves to the new row on
 * `spring.micro`; a keyboard move or reduced motion places it instantly (motion.md §4.4).
 */
export function SelectionPill({ instant = false }: { instant?: boolean }): ReactElement {
  const reduce = useReducedMotion();
  return (
    <m.span
      layoutId="sidebar-selection"
      aria-hidden="true"
      data-testid="sidebar-selection"
      className="pointer-events-none absolute inset-y-0 inset-x-1 rounded-sm bg-selection"
      transition={instant || reduce ? { duration: 0 } : motionSpring(spring.micro)}
    />
  );
}

/**
 * Crossfades the content column between destinations (motion.md §4.5): React's
 * `<ViewTransition>` with the `psy-route` class. It runs only for updates inside
 * `startTransition` (the host starts one for a change of destination, not of thread); the host's
 * stylesheet holds the 180 ms crossfade with a 4 px rise and the reduced-motion rule
 * (apps/web/src/shell/layout/shell-layout.css).
 */
export function RouteTransition({ children }: { children?: ReactNode }): ReactElement {
  return (
    <ViewTransition default="psy-route" name="psy-content">
      {children}
    </ViewTransition>
  );
}
