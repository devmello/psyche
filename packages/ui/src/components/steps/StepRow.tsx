import { ChevronRight } from "lucide-react";
import { useReducedMotionConfig } from "motion/react";
import * as m from "motion/react-m";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import { fadeRise } from "../../motion/primitives.tsx";
import { StatusGlyph, type StepStatusKind } from "../status.tsx";
import { LiveDuration } from "./LiveDuration.tsx";

export interface StepRowProps {
  status: StepStatusKind;
  /** The voice.md status line: present tense while running, past tense once done. */
  label: string;
  /** The target, after a `·` in the secondary label colour ("kayak.com"). */
  target?: string;
  startedAt?: number;
  endedAt?: number;
  /** A fixed "now" for stories and tests. */
  now?: number;
  /** Retried steps show "Attempt n" (n > 1). */
  attempt?: number;
  /** Folded repeats of the same tool and outcome ("×4"). */
  repeats?: number;
  /** Nesting under a helper or a parallel group (0 or 1). */
  level?: 0 | 1;
  /** Right of the label, before the time: a frame thumbnail, a "Waiting for your approval ↓". */
  accessory?: ReactNode;
  /** Disclosure content (the preview, the parameters); the row gets a chevron when present. */
  children?: ReactNode;
  defaultOpen?: boolean;
  /** Enter with `fadeRise` (new live steps); off for rows already on screen. */
  enter?: boolean;
  className?: string;
}

/**
 * One step of a run (docs/design/run-trace-2026.md §3.2): status glyph, label, target, time.
 * The running label carries the shimmer (stops when the step ends; static under reduced motion,
 * where "Running" is said instead). Status changes morph the glyph. A list item: the caller's
 * `<ul>` is the list, and its live region announces starts and outcomes, never ticks.
 */
export function StepRow({
  status,
  label,
  target,
  startedAt,
  endedAt,
  now,
  attempt,
  repeats,
  level = 0,
  accessory,
  children,
  defaultOpen = false,
  enter = false,
  className,
}: StepRowProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const reduce = useReducedMotionConfig() === true;
  const id = useId();
  const running = status === "running" || status === "thinking";
  const hasDetail = children !== undefined && children !== null;
  const motionProps = enter && !reduce ? fadeRise : {};
  const head = (
    <>
      <StatusGlyph status={status} label={t(`design.status.${status}`)} morph />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span
          className={cn("truncate text-body text-label-primary", running && "psy-shimmer")}
          data-active={running || undefined}
        >
          {label}
        </span>
        {target ? (
          <span className="min-w-0 shrink truncate text-callout text-label-secondary">
            <span aria-hidden="true">· </span>
            {target}
          </span>
        ) : null}
        {repeats && repeats > 1 ? (
          <span className="shrink-0 text-callout text-label-secondary tabular-nums">
            {t("design.steps.repeats", { n: repeats })}
          </span>
        ) : null}
        {attempt && attempt > 1 ? (
          <span className="shrink-0 rounded-xs bg-fill-tertiary px-1 text-caption text-label-secondary">
            {t("design.steps.attempts", { n: attempt })}
          </span>
        ) : null}
      </span>
      {accessory}
      {startedAt !== undefined ? (
        <LiveDuration
          startedAt={startedAt}
          endedAt={endedAt}
          {...(now === undefined ? {} : { now })}
          className="text-callout text-label-secondary"
        />
      ) : null}
    </>
  );
  return (
    <m.li
      {...motionProps}
      className={cn("flex flex-col", level === 1 && "ms-5 border-s border-separator ps-3", className)}
      data-step-status={status}
    >
      {hasDetail ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-detail`}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-7 w-full items-center gap-2 rounded-sm px-1 text-start outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
        >
          {head}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-label-tertiary transition-transform duration-(--spring-snappy-duration) ease-(--spring-snappy)",
              open && "rotate-90",
            )}
          />
          <span className="sr-only">
            {open ? t("design.steps.collapse") : t("design.steps.expand")}
          </span>
        </button>
      ) : (
        <div className="flex min-h-7 items-center gap-2 px-1">{head}</div>
      )}
      {hasDetail && open ? (
        <div id={`${id}-detail`} className="ms-7 mb-1 text-callout text-label-secondary">
          {children}
        </div>
      ) : null}
    </m.li>
  );
}
