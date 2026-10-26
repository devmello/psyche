import type { ApprovalStatus, RunStep, TaskStatus, ToolCallStatus } from "@psyche/protocol";
import { TriangleAlert } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { StatusGlyph } from "../components/status.tsx";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { CardEnter, useEntersLater } from "./card-enter.tsx";

/**
 * The one status vocabulary for cards (docs/design/chat-experience-2026.md §4.1). Every source
 * status (tool call, task, approval, run step) maps onto it through one adapter below.
 */
export const CARD_STATUSES = [
  "pending",
  "running",
  "waiting",
  "done",
  "failed",
  "blocked",
  "cancelled",
] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

/** A card's status plus the warning flag (`uncertain` tool calls are done with a warning). */
export interface CardStatusInfo {
  status: CardStatus;
  warning?: boolean;
}

export function fromToolCallStatus(status: ToolCallStatus): CardStatusInfo {
  switch (status) {
    case "ok":
      return { status: "done" };
    case "uncertain":
      return { status: "done", warning: true };
    default:
      return { status };
  }
}

export function fromTaskStatus(status: TaskStatus): CardStatusInfo {
  switch (status) {
    case "queued":
      return { status: "pending" };
    case "awaiting_input":
    case "awaiting_approval":
    case "paused":
      return { status: "waiting" };
    default:
      return { status };
  }
}

export function fromApprovalStatus(status: ApprovalStatus): CardStatusInfo {
  switch (status) {
    case "pending":
      return { status: "waiting" };
    case "approved":
      return { status: "done" };
    case "denied":
      return { status: "failed" };
    default:
      return { status: "cancelled" };
  }
}

export function fromStepStatus(status: RunStep["status"]): CardStatusInfo {
  switch (status) {
    case "ok":
      return { status: "done" };
    case "skipped":
      return { status: "cancelled" };
    default:
      return { status };
  }
}

/** The spoken status, from the catalogue. */
export const cardStatusLabel = (s: CardStatusInfo): string =>
  t("blocks.card.status", { status: s.status, warning: s.warning ? "yes" : "no" });

/**
 * One action model (§4.1): `open` opens the target in the canvas, `send` posts a message or an
 * answer, `confirm` goes through the approval dock, `undo` reverts what the card did.
 */
export interface CardAction {
  id: string;
  label: string;
  kind: "open" | "send" | "confirm" | "undo";
  /** At most one primary per card; it sits on the trailing side (§3.8). */
  primary?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export type CardVariant = "inline" | "framed" | "pinned";

const VARIANT: Record<CardVariant, string> = {
  inline: "my-0.5 text-callout text-label-secondary",
  framed: "my-2 rounded-lg bg-surface-raised p-4 text-label-primary shadow-elevation-1",
  pinned: "my-2 rounded-lg bg-surface-raised px-4 py-3 text-label-primary shadow-elevation-1",
};

export interface CardProps {
  /** The accessible name of the card. */
  label: string;
  variant?: CardVariant;
  icon?: ReactNode;
  title?: ReactNode;
  status?: CardStatusInfo;
  /** Small text after the title (kind, version, time). */
  meta?: ReactNode;
  /** Polite live region on the meta, for cards whose status changes while shown. */
  live?: boolean;
  actions?: readonly CardAction[];
  /** Text at the start of the action bar (a wrap-up's question). */
  actionsLead?: ReactNode;
  /** Button size in the action bar; `sm` except for decision cards. */
  actionSize?: "sm" | "default";
  /** Creation time: a card arriving later than the first wave enters with the list enter. */
  createdAt?: string | null;
  className?: string;
  children?: ReactNode;
  "data-testid"?: string;
}

/**
 * The only card chrome in the transcript (chat-experience-2026 §4.1): header (icon, title,
 * status glyph, meta), body and an action bar. `framed` is the level-1 surface; `inline` is the
 * borderless chip used by activity rows; `pinned` is the framed surface with tighter padding.
 */
export function Card({
  label,
  variant = "framed",
  icon,
  title,
  status,
  meta,
  live = false,
  actions = [],
  actionsLead,
  actionSize = "sm",
  createdAt,
  className,
  children,
  "data-testid": testId,
}: CardProps): ReactElement {
  const later = useEntersLater(createdAt);
  const hasHeader = icon !== undefined || title !== undefined || status !== undefined;
  return (
    <CardEnter animate={later}>
      <article
        aria-label={label}
        data-card={variant}
        data-status={status?.status}
        data-testid={testId}
        className={cn(VARIANT[variant], className)}
      >
        {hasHeader ? (
          <header className="flex min-w-0 items-center gap-2">
            {status ? (
              <StatusGlyph status={status.status} label={cardStatusLabel(status)} morph />
            ) : null}
            {status?.warning ? (
              <TriangleAlert className="size-3.5 shrink-0 text-approval-text" aria-hidden="true" />
            ) : null}
            {icon ? (
              <span className="inline-flex shrink-0 text-label-secondary [&_svg]:size-4">
                {icon}
              </span>
            ) : null}
            {title !== undefined ? (
              <h3
                className={cn("min-w-0 flex-1 truncate", variant !== "inline" && "text-headline")}
              >
                {title}
              </h3>
            ) : null}
            {meta !== undefined ? (
              <span
                className="shrink-0 text-callout text-label-secondary"
                aria-live={live ? "polite" : undefined}
              >
                {meta}
              </span>
            ) : null}
          </header>
        ) : null}
        {children !== undefined ? <div className={cn(hasHeader && "mt-1")}>{children}</div> : null}
        <CardActions actions={actions} lead={actionsLead} size={actionSize} />
      </article>
    </CardEnter>
  );
}

/** The action bar: the primary trails, the rest come first in reading and focus order. */
export function CardActions({
  actions,
  lead,
  size = "sm",
}: {
  actions: readonly CardAction[];
  lead?: ReactNode;
  size?: "sm" | "default";
}): ReactElement | null {
  if (actions.length === 0 && lead === undefined) return null;
  const ordered = [...actions.filter((a) => !a.primary), ...actions.filter((a) => a.primary)];
  return (
    <footer className="mt-3 flex flex-wrap items-center justify-end gap-2">
      {lead !== undefined ? <div className="me-auto">{lead}</div> : null}
      {ordered.map((a) => (
        <Button
          key={a.id}
          size={size}
          variant={a.primary ? "default" : "secondary"}
          disabled={a.disabled}
          data-action-kind={a.kind}
          onClick={a.onSelect}
        >
          {a.label}
        </Button>
      ))}
    </footer>
  );
}
