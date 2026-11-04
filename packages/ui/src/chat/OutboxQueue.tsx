import { Clock, X } from "lucide-react";
import type { ReactElement } from "react";
import { type OutboxItem, outboxItemIsStale } from "../data/outbox.ts";
import { t } from "../i18n/core.ts";

/**
 * Strip above the composer with the messages that wait for the connection (a remote window while
 * the Host is unreachable). Each goes out on reconnect, once; remove takes one back before then.
 */
export function OutboxQueue({
  items,
  onRemove,
  onSendNow,
}: {
  items: readonly OutboxItem[];
  onRemove: (key: string) => void;
  /** Sends a message that waited a day, which asks first. */
  onSendNow?: (key: string) => void;
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <ul
      className="flex flex-wrap justify-center gap-1.5"
      aria-label={t("chat.outbox.list")}
      data-testid="outbox-queue"
    >
      {items.map((item) => (
        <li
          key={item.key}
          className="bg-surface-raised shadow-elevation-1 inline-flex h-7 max-w-full items-center gap-1.5 rounded-full ps-3 pe-1 text-callout text-label-primary"
        >
          <Clock className="size-3.5 shrink-0 text-label-secondary" aria-hidden="true" />
          <span className="shrink-0 text-label-secondary">{t("chat.outbox.waiting")}</span>
          <span className="truncate">{t("chat.quote.text", { text: item.params.content })}</span>
          {onSendNow && outboxItemIsStale(item) ? (
            <>
              <span className="shrink-0 text-label-secondary">{t("chat.outbox.old")}</span>
              <button
                type="button"
                onClick={() => onSendNow(item.key)}
                className="cursor-default rounded-sm px-1 text-accent-11 hover:bg-fill-tertiary"
              >
                {t("chat.outbox.sendNow")}
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => onRemove(item.key)}
            className="inline-flex size-6 cursor-default items-center justify-center rounded-full text-label-secondary hover:bg-fill-tertiary hover:text-label-primary"
            aria-label={t("chat.outbox.remove", { content: item.params.content })}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}
