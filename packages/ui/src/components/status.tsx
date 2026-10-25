import { Ban, Check, CircleDashed, Clock, LoaderCircle, Pause, X } from "lucide-react";
import type { ReactElement } from "react";
import { cn } from "../lib/utils.ts";

export type StatusKind =
  | "running"
  | "done"
  | "failed"
  | "waiting"
  | "paused"
  | "cancelled"
  | "pending";

const GLYPH = {
  running: { Icon: LoaderCircle, tone: "text-label-secondary animate-spin reduced:animate-none" },
  done: { Icon: Check, tone: "text-success-text" },
  failed: { Icon: X, tone: "text-danger-text" },
  waiting: { Icon: Clock, tone: "text-approval-text" },
  paused: { Icon: Pause, tone: "text-label-tertiary" },
  cancelled: { Icon: Ban, tone: "text-label-tertiary" },
  pending: { Icon: CircleDashed, tone: "text-label-tertiary" },
} as const;

export interface StatusGlyphProps {
  status: StatusKind;
  /** Spoken text, e.g. "Running" (through the catalogue). Omit when a visible label says it. */
  label?: string;
  className?: string;
}

/**
 * One glyph per task, tool or approval state across the app (docs/design/redesign-2026.md §3.6):
 * never a dot plus a label plus an icon. Colours come from the fixed semantic scales.
 */
export function StatusGlyph({ status, label, className }: StatusGlyphProps): ReactElement {
  const { Icon, tone } = GLYPH[status];
  return (
    <span className={cn("inline-flex shrink-0 items-center", className)} data-status={status}>
      <Icon className={cn("size-4", tone)} aria-hidden="true" />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
