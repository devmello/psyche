import type { Receipt } from "@psyche/protocol";
import { CircleAlert, CircleCheck, CircleHelp } from "lucide-react";
import type { ReactElement } from "react";
import { formatTime } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { useDisclosure } from "./disclosure.tsx";

/** Provider ids worth naming at level 1, in preference order, with their readable label. */
const PROVIDER_ID: readonly [key: string, label: string][] = [
  ["gmailId", "Gmail id"],
  ["messageId", "message id"],
  ["eventId", "event id"],
  ["pageId", "page id"],
  ["issueId", "issue id"],
  ["orderId", "order id"],
  ["fileId", "file id"],
];

/** "18c4f2a9e3b1d7c0" → "18c4…". */
function shortRef(value: string): string {
  return value.length > 10 ? `${value.slice(0, 4)}…` : value;
}

/** The one provider id a receipt line names ("Gmail id 18c4…"), or null. */
export function providerId(receipt: Receipt): string | null {
  const refs = receipt.externalRefs;
  for (const [key, label] of PROVIDER_ID) {
    const v = refs[key];
    if (typeof v === "string" || typeof v === "number") return `${label} ${shortRef(String(v))}`;
  }
  const other = Object.entries(refs).find(
    ([k, v]) => /Id$/.test(k) && (typeof v === "string" || typeof v === "number"),
  );
  if (other === undefined) return null;
  const label = other[0].replace(/Id$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return `${label} id ${shortRef(String(other[1]))}`;
}

/**
 * One compact line after every external write, with the provider id (UI design §3.2):
 * "Sent to jane.ortiz@example.com · Gmail id 18c4… · 10:07". Uncertain outcomes read "outcome
 * unknown · not retried" (architecture §4.5). The receipt id and every raw provider key are
 * disclosure level 2. Receipts are facts.
 */
export function ReceiptLine({
  receipt,
  onOpen,
}: {
  receipt: Receipt;
  onOpen?: (receipt: Receipt) => void;
}): ReactElement {
  const { level } = useDisclosure();
  const id = providerId(receipt);
  const summary = receipt.summary;
  const outcome =
    receipt.outcome === "uncertain" && !/outcome unknown/i.test(summary)
      ? "outcome unknown · not retried"
      : receipt.outcome === "failed" && !/\bfailed\b/i.test(summary)
        ? "failed"
        : null;
  const Icon =
    receipt.outcome === "ok"
      ? CircleCheck
      : receipt.outcome === "failed"
        ? CircleAlert
        : CircleHelp;
  const raw = Object.entries(receipt.externalRefs)
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(" · ");
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            receipt.outcome === "ok" && "text-success",
            receipt.outcome === "failed" && "text-danger",
            receipt.outcome === "uncertain" && "text-approval-text",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">
          <span className="text-foreground">{summary}</span>
          {outcome ? (
            <span
              className={receipt.outcome === "failed" ? "text-danger-text" : "text-approval-text"}
            >
              {" "}
              · {outcome}
            </span>
          ) : null}
          {id ? <span> · {id}</span> : null}
          <span className="tabular-nums"> · {formatTime(receipt.createdAt)}</span>
        </span>
      </span>
      {level === 2 && (raw !== "" || receipt.shortId) ? (
        <span className="block truncate pl-5 font-mono text-muted-foreground">
          {[receipt.shortId, raw].filter(Boolean).join(" · ")}
        </span>
      ) : null}
    </>
  );
  const cls = "my-1 block w-full text-left text-caption text-muted-foreground";
  return onOpen ? (
    <button
      type="button"
      className={cn(cls, "rounded px-1 -mx-1 transition-colors hover:bg-gray-3")}
      onClick={() => onOpen(receipt)}
    >
      <span className="sr-only">Receipt: </span>
      {content}
    </button>
  ) : (
    <p className={cls}>{content}</p>
  );
}
