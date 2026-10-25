import { ChevronDown, X } from "lucide-react";
import type { ReactElement } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import type { QueuedFollowUp } from "../data/state.ts";
import { t } from "../i18n/core.ts";

const modeLabel = (mode: QueuedFollowUp["mode"]): string => t(`chat.queue.mode.${mode}`);

/**
 * Strip above the composer with the queued messages, their mode and remove (UI design §3.2). The
 * queue mode lives here, not in the composer: a queued message waits for the turn to end, and its
 * mode menu sends it at once to steer the run or to interrupt it.
 */
export function FollowUpQueue({
  items,
  onRemove,
  onRetry,
  onSendNow,
}: {
  items: readonly QueuedFollowUp[];
  onRemove: (id: string) => void;
  /** Re-sends an item whose send failed. */
  onRetry?: (id: string) => void;
  /** Sends a queued item now instead of after the turn. */
  onSendNow?: (item: QueuedFollowUp, mode: "steer" | "interrupt") => void;
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap justify-center gap-1.5" aria-label={t("chat.queue.list")}>
      {items.map((q) => (
        <li
          key={q.id}
          className="material-glass inline-flex h-7 max-w-full items-center gap-1.5 rounded-full ps-3 pe-1 text-callout text-label-primary"
        >
          {onSendNow && !q.failed ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="inline-flex shrink-0 cursor-default items-center gap-0.5 rounded-full text-label-secondary transition-colors duration-(--duration-micro) outline-none hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t("chat.queue.changeWhen", {
                  mode: modeLabel(q.mode),
                  content: q.content,
                })}
              >
                {t("chat.queue.queued", { mode: modeLabel(q.mode) })}
                <ChevronDown className="size-3.5" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => onSendNow(q, "steer")}>
                  {t("chat.queue.sendNowSteer")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSendNow(q, "interrupt")}>
                  {t("chat.queue.sendNowInterrupt")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="shrink-0 text-label-secondary">
              {t("chat.queue.queuedPrefix", { mode: modeLabel(q.mode) })}
            </span>
          )}
          <span className="truncate">{t("chat.quote.text", { text: q.content })}</span>
          {q.failed ? (
            <>
              <span className="text-danger-text">{t("chat.queue.notSent")}</span>
              {onRetry ? (
                <button
                  type="button"
                  onClick={() => onRetry(q.id)}
                  className="cursor-default rounded-sm px-1 text-accent-11 hover:bg-fill-tertiary"
                  aria-label={t("chat.queue.retry", { content: q.content })}
                >
                  {t("common.retry")}
                </button>
              ) : null}
            </>
          ) : null}
          <button
            type="button"
            onClick={() => onRemove(q.id)}
            className="inline-flex size-6 cursor-default items-center justify-center rounded-full text-label-secondary hover:bg-fill-tertiary hover:text-label-primary"
            aria-label={t("chat.queue.remove", { content: q.content })}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}
