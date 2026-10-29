import type { ReviewItem } from "@psyche/protocol";
import { type KeyboardEvent, type ReactElement, useMemo, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { type ReviewAction, ReviewRow } from "./ReviewRow.tsx";

/**
 * The review queue grouped by person (docs/design/everything-memory-2026.md §7.1): per-group
 * "Confirm all" and "Discard all", and the keyboard (J/K to move, Y confirm, E edit, N discard).
 * Keys act only while the list has focus and no field is being edited.
 */

export interface ReviewListProps {
  items: readonly ReviewItem[];
  busy?: boolean;
  /** Act on one item. */
  onAct: (item: ReviewItem, action: ReviewAction) => void;
  /** Act on every item of one person at once (confirm or discard). */
  onActGroup?: (items: readonly ReviewItem[], decision: "confirm" | "discard") => void;
  /** Auto-accepted rows: shows Undo (with the date it lasts to) instead of Confirm and Discard. */
  undoUntil?: (item: ReviewItem) => string | undefined;
  emptyText: string;
}

export function groupByPerson(items: readonly ReviewItem[]): [string, ReviewItem[]][] {
  const groups = new Map<string, ReviewItem[]>();
  for (const item of items) {
    const key = `${item.entityName}\u0000${item.fact.entityId}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([k, v]) => [k.split("\u0000")[0] ?? "", v]);
}

export function ReviewList({
  items,
  busy = false,
  onAct,
  onActGroup,
  undoUntil,
  emptyText,
}: ReviewListProps): ReactElement {
  const groups = useMemo(() => groupByPerson(items), [items]);
  const flat = useMemo(() => groups.flatMap(([, g]) => g), [groups]);
  const [focus, setFocus] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const current = flat[Math.min(focus, Math.max(flat.length - 1, 0))];

  if (items.length === 0) {
    return (
      <p data-testid="review-empty" className="px-3 py-4 text-callout text-label-secondary">
        {emptyText}
      </p>
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (editing !== null || target.closest("input, textarea, [role=menu]") !== null) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "j") {
      setFocus((f) => Math.min(f + 1, flat.length - 1));
    } else if (key === "k") {
      setFocus((f) => Math.max(f - 1, 0));
    } else if (current !== undefined && undoUntil?.(current) === undefined) {
      if (key === "y") onAct(current, { kind: "confirm" });
      else if (key === "n") onAct(current, { kind: "discard" });
      else if (key === "e") setEditing(current.fact.id);
      else return;
    } else {
      return;
    }
    e.preventDefault();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a keyboard-driven list region
    <div
      role="group"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the region takes j/k/a/e shortcuts, so it must be focusable
      tabIndex={0}
      aria-label={t("memoryReview.keys")}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-4 outline-none"
    >
      {groups.map(([name, group]) => (
        <section key={`${name}-${group[0]?.fact.id}`} data-testid="review-group">
          <header className="flex items-center justify-between px-3 pb-1">
            <h3 className="text-headline">{name}</h3>
            {onActGroup && group.length > 1 && undoUntil === undefined ? (
              <span className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => onActGroup(group, "confirm")}
                >
                  {t("memoryReview.group.confirmAll", { n: group.length })}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => onActGroup(group, "discard")}
                >
                  {t("memoryReview.group.discardAll", { n: group.length })}
                </Button>
              </span>
            ) : null}
          </header>
          <ul className="overflow-hidden rounded-lg bg-fill-quaternary">
            {group.map((item) => {
              const until = undoUntil?.(item);
              return (
                <ReviewRow
                  key={item.fact.id}
                  item={item}
                  busy={busy}
                  focused={current?.fact.id === item.fact.id}
                  editing={editing === item.fact.id}
                  onEditingChange={(v) => setEditing(v ? item.fact.id : null)}
                  onAct={onAct}
                  {...(until === undefined ? {} : { undoUntil: until })}
                />
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
