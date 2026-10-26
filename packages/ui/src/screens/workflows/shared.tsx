import { Cloud, Ellipsis, ShieldAlert } from "lucide-react";
import { type ReactElement, type ReactNode, useId } from "react";
import { Card } from "../../blocks/card.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";

/**
 * Pieces every mail and meeting card shares (docs/workflows/mail-and-meetings-2026.md §7.1): the
 * level-1 Feed card without an outline (redesign-2026 §5.6), its kind line, the taint and cloud
 * chips (§3 rules 3 and 7), section headings and the trailing ⋯ row menu.
 */

export interface WorkflowCardFrameProps {
  /** The kind line, in text-caption ("Inbox · 7:30 · 3 need you"). */
  kind: ReactNode;
  title?: ReactNode;
  /** The card's accessible name when it has no visible title. */
  label?: string;
  /** Chips after the kind line: taint, cloud. */
  chips?: ReactNode;
  /** Trailing header control (a Join button, ⋯). */
  trailing?: ReactNode;
  /** The briefing hero is wider, with 24 px padding (§5.6). */
  hero?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  "data-kind"?: string;
}

export function WorkflowCardFrame({
  kind,
  title,
  label,
  chips,
  trailing,
  hero = false,
  children,
  footer,
  className,
  "data-kind": dataKind,
}: WorkflowCardFrameProps): ReactElement {
  const titleId = useId();
  return (
    <Card
      label={label ?? ""}
      {...(title ? { labelledBy: titleId } : {})}
      data-kind={dataKind}
      className={cn("my-0 flex min-w-0 flex-col gap-3", hero ? "p-6 @2xl/column:-mx-3" : "", className)}
      header={
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-label-secondary">
              <span>{kind}</span>
              {chips}
            </p>
            {title ? (
              <h2 id={titleId} className="text-title-2 text-label-primary">
                {title}
              </h2>
            ) : null}
          </div>
          {trailing}
        </div>
      }
    >
      {children}
      {footer ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-callout text-label-secondary">
          {footer}
        </div>
      ) : null}
    </Card>
  );
}

/** "Contains text from <sender>": the run read untrusted content (§3 rule 3). */
export function TaintChip({ from }: { from?: string | null }): ReactElement {
  return (
    <span className="inline-flex items-center gap-1 rounded-xs bg-fill-tertiary px-1.5 py-0.5 text-caption text-label-secondary">
      <ShieldAlert className="size-3" aria-hidden="true" />
      {from ? t("workflows.taint", { sender: from }) : t("workflows.taintOthers")}
    </span>
  );
}

/** A cloud model read mail or a transcript (§3 rule 7). */
export function CloudChip(): ReactElement {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-xs bg-fill-tertiary px-1.5 py-0.5 text-caption text-label-secondary"
      title={t("workflows.cloudHint")}
    >
      <Cloud className="size-3" aria-hidden="true" />
      {t("workflows.cloud")}
      <span className="sr-only">{t("workflows.cloudHint")}</span>
    </span>
  );
}

/** A section heading inside a card: a heading, not a region (several cards repeat the names). */
export function CardSection({
  title,
  children,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <h3 className="text-subheadline font-medium text-label-secondary">{title}</h3>
      {children}
    </div>
  );
}

/** A grouped row (§5.8): separated by a hairline inset, never a box per row. */
export const ROW =
  "group/row relative flex min-h-9 min-w-0 items-start gap-3 py-2 before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-separator first:before:hidden";

/** Actions that appear on hover or focus, and always on touch. */
export const REVEAL =
  "opacity-0 transition-opacity duration-(--duration-micro) group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100 reduced:transition-none";

export interface RowMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
}

/** The trailing ⋯ of a row: its per-row actions (§7.1). */
export function RowMenu({
  label,
  items,
  className,
}: {
  /** "More for <subject>". */
  label: string;
  items: readonly RowMenuItem[];
  className?: string;
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            title={t("common.more")}
            className={cn("-my-1 text-label-secondary", className)}
          />
        }
      >
        <Ellipsis aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {items.map((item) => (
          <DropdownMenuItem key={item.id} onClick={item.onSelect}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The sender as a name: "Dana Ruiz <dana@…>" → "Dana Ruiz"; a bare address stays. */
export function senderName(from: string | undefined): string {
  if (from === undefined || from.trim() === "") return t("workflows.digest.someone");
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from);
  return (m?.[1] ?? from).trim();
}

/** Whole days between two instants (never negative). */
export function daysBetween(fromIso: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(fromIso)) / 86_400_000));
}
