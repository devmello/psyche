import type { ReviewItem } from "@psyche/protocol";
import { Check, MoreHorizontal, Pencil, Undo2, X } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Input } from "../components/ui/input.tsx";
import { t } from "../i18n/core.ts";
import { formatDate } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";

/**
 * One proposed fact (docs/design/everything-memory-2026.md §7.1). The sentence, the quote and the
 * source are text from the owner's own items or, later, other people's: they are rendered as plain
 * text only, never as markup or links.
 */

export type ReviewAction =
  | { kind: "confirm" }
  | { kind: "discard"; never?: "attribute_for_entity" | "attribute_from_sender" }
  | { kind: "edit"; value: string }
  | { kind: "undo" };

export interface ReviewRowProps {
  item: ReviewItem;
  focused?: boolean;
  busy?: boolean;
  /** Already accepted automatically: shows Undo instead of Confirm and Discard. */
  undoUntil?: string;
  onAct: (item: ReviewItem, action: ReviewAction) => void;
  /** Lets the list drive the inline editor from the keyboard. */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
}

export function confidenceBand(c: number): "high" | "medium" | "low" {
  return c >= 0.85 ? "high" : c >= 0.6 ? "medium" : "low";
}

export function ReviewRow({
  item,
  focused = false,
  busy = false,
  undoUntil,
  onAct,
  editing: editingProp,
  onEditingChange,
}: ReviewRowProps): ReactElement {
  const { fact } = item;
  const labelId = useId();
  const [editingState, setEditingState] = useState(false);
  const editing = editingProp ?? editingState;
  const setEditing = (v: boolean) => {
    setEditingState(v);
    onEditingChange?.(v);
  };
  const [draft, setDraft] = useState(fact.value);
  const cite = item.citations[0];
  const band = confidenceBand(fact.confidence);
  const sensitive = fact.sensitivity !== undefined && fact.sensitivity !== "none";
  const attribute = t(`people.attr.${fact.attribute}`);

  const change =
    item.change === "new"
      ? t("memoryReview.change.new")
      : t(`memoryReview.change.${item.change}`, { previous: item.previousValue ?? "" });

  return (
    <li
      data-testid="review-row"
      data-focused={focused ? "true" : undefined}
      aria-labelledby={labelId}
      className={cn(
        "relative flex flex-col gap-1 px-3 py-2 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden",
        focused && "bg-fill-tertiary",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          title={t(`memoryReview.confidence.${band}`)}
          data-confidence={band}
          className={cn(
            "mt-2 size-2 shrink-0 rounded-full",
            band === "high" ? "bg-success" : band === "medium" ? "bg-warning" : "bg-label-tertiary",
          )}
        >
          <span className="sr-only">{t(`memoryReview.confidence.${band}`)}</span>
        </span>
        <div className="min-w-0 flex-1">
          <p id={labelId} className="text-body">
            {t("memoryReview.attr.sentence", {
              name: item.entityName,
              attribute,
              value: fact.value,
            })}
          </p>
          <p className="flex flex-wrap items-center gap-x-2 text-callout text-label-secondary">
            <span data-testid="review-change">{change}</span>
            {sensitive ? (
              <span data-testid="review-sensitive" className="text-approval-text">
                {t("memoryReview.sensitive", { kind: fact.sensitivity ?? "" })}
              </span>
            ) : null}
            {cite ? (
              <span data-testid="review-source">
                {t("memoryReview.source", {
                  source: cite.source,
                  date: formatDate(cite.observedAt),
                })}
              </span>
            ) : null}
          </p>
          {cite ? (
            <blockquote
              data-testid="review-quote"
              className="mt-1 border-l-2 border-separator pl-2 text-callout text-label-secondary"
            >
              {t("memoryReview.quote", { quote: cite.quote })}
            </blockquote>
          ) : null}
          {undoUntil !== undefined ? (
            <p className="text-callout text-label-tertiary">
              {t("memoryReview.recent.undoUntil", { date: formatDate(undoUntil) })}
            </p>
          ) : null}
        </div>
        {editing ? null : (
          <div className="flex shrink-0 items-center gap-1">
            {undoUntil !== undefined ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onAct(item, { kind: "undo" })}
              >
                <Undo2 aria-hidden="true" className="size-3.5" />
                {t("memoryReview.undo")}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => onAct(item, { kind: "confirm" })}
                  aria-label={`${t("memoryReview.confirm")}: ${item.sentence}`}
                >
                  <Check aria-hidden="true" className="size-3.5" />
                  {t("memoryReview.confirm")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setDraft(fact.value);
                    setEditing(true);
                  }}
                >
                  <Pencil aria-hidden="true" className="size-3.5" />
                  {t("memoryReview.edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => onAct(item, { kind: "discard" })}
                >
                  <X aria-hidden="true" className="size-3.5" />
                  {t("memoryReview.discard")}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button size="icon" variant="ghost" aria-label={t("memoryReview.more")} />
                    }
                  >
                    <MoreHorizontal aria-hidden="true" className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() =>
                        onAct(item, { kind: "discard", never: "attribute_for_entity" })
                      }
                    >
                      {t("memoryReview.never.entity", { name: item.entityName })}
                    </DropdownMenuItem>
                    {cite?.authorEntityId ? (
                      <DropdownMenuItem
                        onClick={() =>
                          onAct(item, { kind: "discard", never: "attribute_from_sender" })
                        }
                      >
                        {t("memoryReview.never.sender")}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        )}
      </div>
      {editing ? (
        <form
          className="flex items-center gap-2 pl-4"
          onSubmit={(e) => {
            e.preventDefault();
            const value = draft.trim();
            if (value !== "") onAct(item, { kind: "edit", value });
            setEditing(false);
          }}
        >
          <Input
            autoFocus
            aria-label={t("memoryReview.editLabel")}
            value={draft}
            maxLength={200}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
            className="h-7 min-w-0 flex-1"
          />
          <Button type="submit" size="sm" disabled={busy || draft.trim() === ""}>
            {t("memoryReview.save")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {t("memoryReview.cancel")}
          </Button>
        </form>
      ) : null}
    </li>
  );
}
