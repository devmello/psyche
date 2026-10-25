import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { type ReactElement, useEffect, useRef } from "react";
import { t } from "../../i18n/core.ts";
import { formatDate } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";
import { duration, motionSpring, spring } from "../../motion/index.ts";
import type { GoalMilestoneView } from "./goal-plan.ts";

const seconds = (ms: number) => ms / 1000;

/** The check mark inside a done node: it draws once when the milestone completes (motion §4.4). */
function CheckMark({ animate }: { animate: boolean }): ReactElement {
  const reduced = useReducedMotion() ?? false;
  return (
    <svg viewBox="0 0 16 16" className="size-3" aria-hidden="true" focusable="false">
      <m.path
        d="M3.5 8.5l3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={animate ? (reduced ? { opacity: 0 } : { pathLength: 0 }) : false}
        animate={reduced ? { opacity: 1 } : { pathLength: 1 }}
        transition={{ duration: seconds(reduced ? duration.short : 200) }}
      />
    </svg>
  );
}

export interface MilestoneTrackProps {
  milestones: readonly GoalMilestoneView[];
  className?: string;
}

/**
 * A goal's milestones as a horizontal track with filled nodes (redesign §5.6). The fill between
 * nodes grows with `scaleX` on `spring.emphasis` when a milestone completes, and the new node's
 * check mark draws. Under reduced motion the fill is instant and the mark fades in (motion §7).
 * The list stays an ordered list with each node's state spoken.
 */
export function MilestoneTrack({ milestones, className }: MilestoneTrackProps): ReactElement {
  const done = milestones.filter((x) => x.done).length;
  const lastDone = milestones.reduce((acc, x, i) => (x.done ? i : acc), -1);
  const nextIndex = milestones.findIndex((x) => !x.done);
  const fraction =
    milestones.length <= 1 ? (done > 0 ? 1 : 0) : Math.max(0, lastDone) / (milestones.length - 1);
  // Only milestones that complete while the page is open animate; the first render is still.
  const seen = useRef<ReadonlySet<number> | null>(null);
  const before = seen.current;
  useEffect(() => {
    seen.current = new Set(milestones.flatMap((x, i) => (x.done ? [i] : [])));
  });

  return (
    <div className={cn("relative", className)}>
      {milestones.length > 1 ? (
        <div
          aria-hidden="true"
          className="absolute top-2.5 h-0.5 rounded-full bg-separator-strong"
          style={{
            insetInlineStart: `calc(100% / ${milestones.length} / 2)`,
            insetInlineEnd: `calc(100% / ${milestones.length} / 2)`,
          }}
        >
          <m.div
            className="h-full origin-left rounded-full bg-grass-9 rtl:origin-right"
            initial={false}
            animate={{ scaleX: fraction }}
            transition={motionSpring(spring.emphasis)}
          />
        </div>
      ) : null}
      <ol
        aria-label={t("screens.goals.milestonesDone", { done, total: milestones.length })}
        className="relative grid"
        style={{ gridTemplateColumns: `repeat(${milestones.length}, minmax(0, 1fr))` }}
      >
        {milestones.map((x, i) => {
          const isNext = i === nextIndex;
          return (
            <li key={x.title} className="flex flex-col items-center gap-1.5 px-1 text-center">
              <span
                aria-hidden="true"
                className={cn(
                  "relative flex size-5 items-center justify-center rounded-full transition-colors",
                  x.done
                    ? "bg-grass-9 text-white"
                    : isNext
                      ? "bg-canvas shadow-[inset_0_0_0_2px_var(--accent-8)]"
                      : "bg-canvas shadow-[inset_0_0_0_1.5px_var(--separator-strong)]",
                )}
              >
                {x.done ? <CheckMark animate={before !== null && !before.has(i)} /> : null}
              </span>
              <span
                className={cn(
                  "line-clamp-2 text-callout",
                  x.done || isNext ? "text-label-primary" : "text-label-secondary",
                )}
              >
                {x.title}
              </span>
              <span className="sr-only">
                {x.done ? t("screens.goals.done") : t("screens.goals.notDone")}
              </span>
              {x.dueAt ? (
                <span className="text-subheadline text-label-tertiary tabular-nums">
                  {formatDate(x.dueAt)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
