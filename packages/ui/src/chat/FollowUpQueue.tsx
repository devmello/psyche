import { ChevronDown, X } from "lucide-react";
import type { ReactElement } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import type { QueuedFollowUp } from "../data/state.ts";

const MODE_LABEL: Record<QueuedFollowUp["mode"], string> = {
  followUp: "after this turn",
  steer: "steer",
  interrupt: "interrupt",
};

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
    <ul className="flex flex-wrap gap-1.5 px-1 pb-1.5" aria-label="Queued messages">
      {items.map((q) => (
        <li
          key={q.id}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-gray-6 bg-gray-2 py-0.5 pr-1 pl-2.5 text-small"
        >
          {onSendNow && !q.failed ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Queued ${MODE_LABEL[q.mode]}. Change when "${q.content}" is sent`}
              >
                Queued ({MODE_LABEL[q.mode]})
                <ChevronDown className="size-3.5" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => onSendNow(q, "steer")}>
                  Send now, to steer
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSendNow(q, "interrupt")}>
                  Send now, interrupting
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="shrink-0 text-muted-foreground">Queued ({MODE_LABEL[q.mode]}):</span>
          )}
          <span className="truncate">"{q.content}"</span>
          {q.failed ? (
            <>
              <span className="text-danger-text">not sent</span>
              {onRetry ? (
                <button
                  type="button"
                  onClick={() => onRetry(q.id)}
                  className="rounded px-1 text-accent-11 hover:bg-gray-4"
                  aria-label={`Retry sending "${q.content}"`}
                >
                  Retry
                </button>
              ) : null}
            </>
          ) : null}
          <button
            type="button"
            onClick={() => onRemove(q.id)}
            className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-gray-4 hover:text-foreground"
            aria-label={`Remove queued message "${q.content}"`}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}
