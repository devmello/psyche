import { ExternalLink } from "lucide-react";
import { type ReactElement, useId } from "react";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { t } from "../i18n/core.ts";
import { formatDate } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { ProvenanceGlyph } from "./glyphs.tsx";
import type { GraphLoop, GraphLoopStatus } from "./types.ts";

export interface LoopRowProps {
  loop: GraphLoop;
  now: number;
  /** Hide the counterpart (on that person's own card). */
  hideCounterpart?: boolean;
  onUpdate?: (loop: GraphLoop, status: GraphLoopStatus) => void;
  onOpenLink?: (link: string) => void;
  busy?: boolean;
}

/** Actions that appear on hover or focus, and always on touch. */
export const revealOnHover =
  "opacity-0 transition-opacity duration-(--duration-micro) group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100";

/**
 * An open loop as a checkbox row (spec §4.6, §6.5): the text, who it's with, the due date and a
 * link back. Ticking it marks it done; "Not a loop" dismisses it. A suggested loop (from someone
 * else's message) has no checkbox: it says where it came from and asks Confirm / Not a loop.
 */
export function LoopRow({
  loop,
  now,
  hideCounterpart = false,
  onUpdate,
  onOpenLink,
  busy = false,
}: LoopRowProps): ReactElement {
  const textId = useId();
  const suggested = loop.status === "suggested";
  const done = loop.status === "done";
  const overdue =
    !done && loop.dueAt != null && Date.parse(loop.dueAt) < now && loop.status === "open";
  const meta: string[] = [
    loop.direction === "i_owe" ? t("people.loop.iOwe") : t("people.loop.waitingOn"),
  ];
  if (!hideCounterpart && loop.counterpart)
    meta.push(t("people.loop.with", { name: loop.counterpart.name }));
  if (loop.project) meta.push(loop.project.name);
  const link = loop.source?.link ?? null;

  return (
    <div
      className={cn(
        "group/row relative flex min-h-9 items-start gap-3 px-3 py-2 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden",
      )}
    >
      {suggested ? (
        <ProvenanceGlyph provenance={loop.provenance} className="mt-0.5 size-4 justify-center" />
      ) : (
        <Checkbox
          className="mt-0.5"
          checked={done}
          disabled={busy}
          aria-label={t("people.loop.markDone", { text: loop.text })}
          onCheckedChange={(checked) => onUpdate?.(loop, checked === true ? "done" : "open")}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          id={textId}
          className={cn(
            "text-body",
            done ? "text-label-tertiary line-through" : "text-label-primary",
          )}
        >
          {loop.text}
        </span>
        <span className="text-callout text-label-secondary">
          {meta.join(" · ")}
          {loop.dueAt ? (
            <span className={overdue ? "text-danger-text" : undefined}>
              {" · "}
              {overdue
                ? t("people.loop.overdue", { date: formatDate(loop.dueAt) })
                : t("people.loop.due", { date: formatDate(loop.dueAt) })}
            </span>
          ) : null}
        </span>
        {suggested ? (
          <span className="mt-0.5 text-callout text-approval-text">
            {t("people.loop.suggested", {
              name: loop.source?.from ?? loop.counterpart?.name ?? "",
              source: t(`people.source.${loop.source?.kind ?? "mail"}`),
            })}
          </span>
        ) : null}
        {suggested ? (
          <span className="mt-1.5 flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              aria-describedby={textId}
              onClick={() => onUpdate?.(loop, "open")}
            >
              {t("people.loop.confirm")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-describedby={textId}
              onClick={() => onUpdate?.(loop, "dismissed")}
            >
              {t("people.loop.notALoop")}
            </Button>
          </span>
        ) : null}
      </div>
      {!suggested ? (
        <span className={cn("flex shrink-0 items-center gap-0.5", revealOnHover)}>
          {!done ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-describedby={textId}
              onClick={() => onUpdate?.(loop, "dismissed")}
            >
              {t("people.loop.notALoop")}
            </Button>
          ) : null}
        </span>
      ) : null}
      {link && onOpenLink ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="shrink-0 text-label-secondary"
          aria-label={t("people.source.open")}
          aria-describedby={textId}
          title={t("people.source.open")}
          onClick={() => onOpenLink(link)}
        >
          <ExternalLink aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
