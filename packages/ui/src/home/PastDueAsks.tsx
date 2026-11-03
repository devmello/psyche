import type { CatchUpActAction, CatchUpItem } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { catchUpRoute } from "./CatchUp.tsx";

/**
 * The past-due question in Needs you (docs/design/memory-everything-2026.md §5.4, §5.6): "Did you
 * finish ...?" with Handed in, Done and Still working. It is the one place Catching up's data
 * turns amber, because it is the one that needs the owner; the Gateway words it and says which
 * lines are questions (`ask`). Silence never changes a status. The accent stays with Approve, so
 * these are outline buttons.
 */
export function PastDueAsks({
  items,
  busy,
  onAct,
  onOpen,
}: {
  items: readonly CatchUpItem[];
  busy: ReadonlySet<string>;
  onAct: (entityId: string, action: CatchUpActAction) => void;
  onOpen: (route: string) => void;
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <ul
      aria-label={t("home.ask.list")}
      data-testid="past-due-asks"
      className="flex flex-col rounded-lg bg-surface-raised shadow-elevation-1"
    >
      {items.map((item) => {
        const disabled = busy.has(item.entityId);
        const overdue = item.urgency === "overdue";
        return (
          <li
            key={item.entityId}
            data-testid="past-due-ask"
            className="relative flex flex-col gap-2 px-3 py-2.5 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden"
          >
            <div className="flex items-start gap-2">
              {overdue ? (
                <span className="mt-0.5 shrink-0 rounded-sm bg-amber-3 px-1.5 text-callout font-medium text-approval-text">
                  {t("work.group.past_due")}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => onOpen(catchUpRoute(item.entityId))}
                aria-label={t("home.catchUp.open", { title: item.title })}
                className="min-w-0 flex-1 rounded-sm text-start text-body text-label-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {item.line}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {item.kind === "assignment" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  aria-label={t("home.ask.handedInLabel", { title: item.title })}
                  onClick={() => onAct(item.entityId, "submitted")}
                >
                  {t("work.status.submitted")}
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                aria-label={t("work.row.markDone", { name: item.title })}
                onClick={() => onAct(item.entityId, "done")}
              >
                {t("common.done")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                aria-label={t("home.ask.stillWorkingLabel", { title: item.title })}
                onClick={() => onAct(item.entityId, "still_working")}
              >
                {t("home.ask.stillWorking")}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
