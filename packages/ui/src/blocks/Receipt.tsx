import type { Receipt } from "@psyche/protocol";
import { CircleAlert, CircleCheck, CircleHelp } from "lucide-react";
import type { ReactElement } from "react";
import { formatTime } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";

/**
 * One compact line after every external write, with the provider id (UI design §3.2). Uncertain
 * outcomes read "outcome unknown · not retried" (architecture §4.5). Receipts are facts.
 */
export function ReceiptLine({
  receipt,
  onOpen,
}: {
  receipt: Receipt;
  onOpen?: (receipt: Receipt) => void;
}): ReactElement {
  const refs = Object.entries(receipt.externalRefs)
    .map(([k, v]) => `${k} ${String(v).length > 10 ? `${String(v).slice(0, 8)}…` : v}`)
    .join(" · ");
  const Icon =
    receipt.outcome === "ok"
      ? CircleCheck
      : receipt.outcome === "failed"
        ? CircleAlert
        : CircleHelp;
  const content = (
    <>
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          receipt.outcome === "ok" && "text-success",
          receipt.outcome === "failed" && "text-danger",
          receipt.outcome === "uncertain" && "text-approval-text",
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 truncate text-foreground">{receipt.summary}</span>
      {receipt.outcome === "uncertain" ? (
        <span className="text-approval-text">outcome unknown · not retried</span>
      ) : receipt.outcome === "failed" ? (
        <span className="text-danger-text">failed</span>
      ) : null}
      {refs ? <span className="truncate font-mono text-muted-foreground">{refs}</span> : null}
      <span className="text-muted-foreground tabular-nums">{formatTime(receipt.createdAt)}</span>
      {receipt.shortId ? (
        <span className="font-mono text-muted-foreground">{receipt.shortId}</span>
      ) : null}
    </>
  );
  const cls = "my-1 flex w-full items-center gap-2 text-left text-xs";
  return onOpen ? (
    <button
      type="button"
      className={cn(cls, "rounded hover:bg-gray-3")}
      onClick={() => onOpen(receipt)}
      aria-label={`Receipt: ${receipt.summary}`}
    >
      {content}
    </button>
  ) : (
    <p className={cls}>{content}</p>
  );
}
