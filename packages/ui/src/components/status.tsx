import {
  Ban,
  Brain,
  Check,
  CircleDashed,
  CircleSlash,
  Clock,
  LoaderCircle,
  Pause,
  RotateCw,
  X,
} from "lucide-react";
import { useReducedMotionConfig } from "motion/react";
import * as m from "motion/react-m";
import { type ReactElement, useRef } from "react";
import { cn } from "../lib/utils.ts";
import { duration, motionSpring, spring } from "../motion/tokens.ts";

export type StatusKind =
  | "running"
  | "done"
  | "failed"
  | "waiting"
  | "paused"
  | "cancelled"
  | "pending";

/** Run-trace step glyphs add thinking, retried and skipped (docs/design/run-trace-2026.md §3.2). */
export type StepStatusKind = StatusKind | "thinking" | "retried" | "skipped";

const GLYPH = {
  running: { Icon: LoaderCircle, tone: "text-label-secondary animate-spin reduced:animate-none" },
  done: { Icon: Check, tone: "text-success-text" },
  failed: { Icon: X, tone: "text-danger-text" },
  waiting: { Icon: Clock, tone: "text-approval-text" },
  paused: { Icon: Pause, tone: "text-label-tertiary" },
  cancelled: { Icon: Ban, tone: "text-label-tertiary" },
  pending: { Icon: CircleDashed, tone: "text-label-tertiary" },
  thinking: { Icon: Brain, tone: "text-label-secondary" },
  retried: { Icon: RotateCw, tone: "text-approval-text" },
  skipped: { Icon: CircleSlash, tone: "text-label-tertiary" },
} as const;

/** A run step's status (protocol `RunStep.status`) as a glyph kind. */
export function stepStatusKind(
  status: "pending" | "running" | "ok" | "failed" | "waiting" | "cancelled" | "skipped",
): StepStatusKind {
  return status === "ok" ? "done" : status;
}

export interface StatusGlyphProps {
  status: StepStatusKind;
  /** Spoken text, e.g. "Running" (through the catalogue). Omit when a visible label says it. */
  label?: string;
  /**
   * Animate status changes (run-trace §3.7): the glyph crossfades over `duration.short` and a
   * new ✓ scales in on `spring.micro`. The first render never animates. Reduced motion: none.
   */
  morph?: boolean;
  className?: string;
}

/**
 * One glyph per task, tool, step or approval state across the app (docs/design/redesign-2026.md
 * §3.6): never a dot plus a label plus an icon. Colours come from the fixed semantic scales.
 */
export function StatusGlyph({ status, label, morph = false, className }: StatusGlyphProps): ReactElement {
  const { Icon, tone } = GLYPH[status];
  const reduce = useReducedMotionConfig() === true;
  const first = useRef(status);
  const animate = morph && !reduce && first.current !== status;
  return (
    <span className={cn("inline-flex shrink-0 items-center", className)} data-status={status}>
      {morph ? (
        <m.span
          key={status}
          className="inline-flex"
          initial={animate ? { opacity: 0, scale: status === "done" ? 0.8 : 1 } : false}
          animate={{ opacity: 1, scale: 1 }}
          transition={{
            opacity: { duration: duration.short / 1000, ease: "linear" },
            scale: motionSpring(spring.micro),
          }}
        >
          <Icon className={cn("size-4", tone)} aria-hidden="true" />
        </m.span>
      ) : (
        <Icon className={cn("size-4", tone)} aria-hidden="true" />
      )}
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
