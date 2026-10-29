import type { QuarantineAction, QuarantineItem } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { formatDate } from "../lib/format.ts";

/**
 * Items held back from extraction (docs/design/everything-memory-2026.md §5.6). The excerpt is
 * text from the item, shown as plain, unformatted text; nothing in it is a link or a command.
 */
export function QuarantineList({
  items,
  busy = false,
  onAct,
  emptyText,
}: {
  items: readonly QuarantineItem[];
  busy?: boolean;
  onAct: (item: QuarantineItem, action: QuarantineAction) => void;
  emptyText: string;
}): ReactElement {
  if (items.length === 0) {
    return (
      <p data-testid="quarantine-empty" className="px-3 py-4 text-callout text-label-secondary">
        {emptyText}
      </p>
    );
  }
  return (
    <ul className="overflow-hidden rounded-lg bg-fill-quaternary">
      {items.map((q) => (
        <li
          key={q.id}
          data-testid="quarantine-row"
          className="relative flex flex-col gap-1 px-3 py-2 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden"
        >
          <p className="text-body">
            {q.reasons.map((r) => t(`memoryReview.quarantine.reason.${r}`)).join(" · ")}
          </p>
          <p className="text-callout text-label-secondary">
            {t("memoryReview.source", { source: q.source, date: formatDate(q.createdAt) })}
          </p>
          <p className="sr-only">{t("memoryReview.quarantine.excerpt")}</p>
          <pre
            data-testid="quarantine-excerpt"
            className="whitespace-pre-wrap break-words rounded-md bg-fill-tertiary px-2 py-1 font-mono text-callout text-label-secondary"
          >
            {q.excerpt}
          </pre>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="sm"
              disabled={busy}
              title={t("memoryReview.quarantine.releaseHint")}
              onClick={() => onAct(q, "release")}
            >
              {t("memoryReview.quarantine.release")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAct(q, "discard")}>
              {t("memoryReview.quarantine.discard")}
            </Button>
            {q.senderEntityId !== null ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onAct(q, "block_sender")}
              >
                {t("memoryReview.quarantine.block")}
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
