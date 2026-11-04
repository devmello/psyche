import type { CatchUpItem } from "@psyche/protocol";
import { ChevronRight } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { isMessageId, t } from "../i18n/core.ts";
import { SourceViewer } from "../screens/search/SourceViewer.tsx";
import { CATCH_UP_LIMIT } from "./use-catch-up.ts";

/** Where a line opens: the item's page in Memory. */
export const catchUpRoute = (entityId: string): string =>
  `/memory?entity=${encodeURIComponent(entityId)}`;
/** "All work due ›" and the way to the whole list. */
export const WORK_DUE_ROUTE = "/memory?kind=due";
/** Where the work items waiting for the owner's OK are listed. */
export const REVIEW_ROUTE = "/memory/review";

function sourceName(kind: string): string {
  const id = `everything.source.${kind}`;
  return isMessageId(id) ? t(id) : kind;
}

/**
 * "Catching up" (docs/design/memory-everything-2026.md §5.6): the few lines `memory.catchup.list`
 * ranks for Home, at most three, each the Gateway's own sentence (already filtered for this
 * surface: nothing is added or re-ranked here). Plain ink, never amber: amber is the past-due
 * question in Needs you. Nothing is drawn without a line or a suggestion waiting to be confirmed.
 */
export function CatchUp({
  items,
  pendingCount = 0,
  onOpen,
}: {
  items: readonly CatchUpItem[];
  /** Work suggestions waiting for the owner: counted, never listed. */
  pendingCount?: number;
  onOpen?: (route: string) => void;
}): ReactElement | null {
  const rows = items.slice(0, CATCH_UP_LIMIT);
  // The passage open under one line (one at a time): the line's entity and the document.
  const [open, setOpen] = useState<{ entityId: string; docId: string } | null>(null);
  if (rows.length === 0 && pendingCount === 0) return null;
  return (
    <section
      id="catching-up"
      aria-labelledby="catch-up-heading"
      className="flex flex-col gap-2"
      data-testid="catching-up"
    >
      <div className="flex items-baseline gap-2 px-1">
        <h3 id="catch-up-heading" className="text-body font-medium text-label-primary">
          {t("home.catchUp")}
        </h3>
        <p className="min-w-0 truncate text-callout text-label-secondary">
          {t("home.catchUp.hint")}
        </p>
        {onOpen ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="ms-auto shrink-0"
            onClick={() => onOpen(WORK_DUE_ROUTE)}
          >
            {t("home.catchUp.all")}
          </Button>
        ) : null}
      </div>
      <ul
        aria-labelledby="catch-up-heading"
        className="flex flex-col rounded-lg bg-surface-raised p-1 shadow-elevation-1"
        data-testid="catch-up"
      >
        {rows.map((item) => (
          <li
            key={item.entityId}
            className="relative before:absolute before:inset-x-2.5 before:top-0 before:h-px before:bg-separator first:before:hidden"
          >
            <div className="flex items-center">
              {onOpen ? (
                <button
                  type="button"
                  onClick={() => onOpen(catchUpRoute(item.entityId))}
                  aria-label={t("home.catchUp.open", { title: item.title })}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-sm px-2.5 py-1.5 text-start outline-none transition-colors hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1 text-body text-label-primary">{item.line}</span>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-label-tertiary rtl:-scale-x-100"
                  />
                </button>
              ) : (
                <p className="flex min-h-11 min-w-0 flex-1 items-center px-2.5 py-1.5 text-body text-label-primary">
                  {item.line}
                </p>
              )}
              {(item.sources ?? []).length > 0 ? (
                <span className="flex shrink-0 gap-1 pe-2">
                  {(item.sources ?? []).map((s) => (
                    <Badge
                      key={s.docId}
                      variant="outline"
                      data-testid="catch-up-source"
                      render={
                        <button
                          type="button"
                          aria-expanded={open?.docId === s.docId && open.entityId === item.entityId}
                          onClick={() =>
                            setOpen(
                              open?.docId === s.docId && open.entityId === item.entityId
                                ? null
                                : { entityId: item.entityId, docId: s.docId },
                            )
                          }
                        />
                      }
                    >
                      {t("home.catchUp.source", { source: sourceName(s.sourceKind) })}
                    </Badge>
                  ))}
                </span>
              ) : null}
            </div>
            {open?.entityId === item.entityId ? (
              <div className="px-2.5 pb-2">
                <SourceViewer docId={open.docId} />
              </div>
            ) : null}
          </li>
        ))}
        {pendingCount > 0 ? (
          <li
            data-testid="catch-up-pending"
            className="relative before:absolute before:inset-x-2.5 before:top-0 before:h-px before:bg-separator first:before:hidden"
          >
            <button
              type="button"
              onClick={() => onOpen?.(REVIEW_ROUTE)}
              className="flex min-h-11 w-full items-center gap-3 rounded-sm px-2.5 py-1.5 text-start text-callout text-label-secondary outline-none transition-colors hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="min-w-0 flex-1">
                {t("home.catchUp.pending", { n: pendingCount })}
              </span>
              <ChevronRight
                aria-hidden="true"
                className="size-4 shrink-0 text-label-tertiary rtl:-scale-x-100"
              />
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
