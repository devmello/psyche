import { Quote } from "lucide-react";
import { type ReactElement, useState } from "react";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { useSlots } from "../slots.tsx";
import type { BlockOf } from "./types.ts";

/**
 * The sources behind a `search_everything` answer: one chip per item that opens it (mail, message,
 * file, note, artifact) in its pane, and a "show the source" expander with the cited passage. All
 * text comes from mail, messages and files written by others (untrusted): plain text only, never
 * Markdown, with the untrusted border on items from someone else.
 */
const KNOWN = new Set(["mail", "messages", "notes", "calendar", "library"]);

function sourceLabel(source: string): string {
  return KNOWN.has(source)
    ? t(`blocks.sources.kind.${source}` as "blocks.sources.kind.mail")
    : t("blocks.sources.kind.other", { source });
}

export function SourceChips({ block }: { block: BlockOf<"sources"> }): ReactElement {
  const [shown, setShown] = useState<string | null>(null);
  const { navigate } = useSlots();
  return (
    <div className="my-1 text-sm" data-testid="source-chips">
      <ul className="flex flex-wrap items-center gap-1.5" aria-label={t("blocks.sources.label")}>
        {block.items.map((item) => {
          const title = item.title || t("blocks.sources.untitled");
          return (
            <li key={item.id} className="flex items-center">
              <button
                type="button"
                title={t("blocks.sources.open", { title })}
                disabled={!item.route || navigate === undefined}
                className={cn(
                  "inline-flex max-w-56 items-center gap-1 rounded-full border border-border bg-gray-2 px-2 py-0.5 text-callout text-gray-12 hover:bg-gray-3 disabled:opacity-60",
                  item.provenance === "untrusted" && "border-untrusted",
                )}
                onClick={() => (item.route ? navigate?.(item.route) : undefined)}
              >
                <span className="text-muted-foreground">{sourceLabel(item.source)}</span>
                <span className="truncate">{title}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="mt-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-callout text-gray-11 hover:bg-gray-3"
        aria-expanded={shown !== null}
        onClick={() =>
          setShown(shown === null ? (block.cited[0] ?? block.items[0]?.id ?? null) : null)
        }
      >
        <Quote className="size-3.5" aria-hidden="true" />
        {shown === null ? t("blocks.sources.show") : t("blocks.sources.hide")}
      </button>
      {shown !== null ? (
        <ul className="mt-1 flex flex-col gap-1.5">
          {(block.cited.length > 0
            ? block.items.filter((i) => block.cited.includes(i.id))
            : block.items
          ).map((item) => (
            <li
              key={item.id}
              className={cn(
                "ms-1 border-s-2 ps-2",
                item.provenance === "untrusted" ? "border-untrusted" : "border-border",
              )}
            >
              <div className="text-callout text-muted-foreground">
                {[sourceLabel(item.source), item.title, item.date].filter(Boolean).join(" · ")}
                {item.provenance === "untrusted" ? ` · ${t("blocks.sources.untrusted")}` : ""}
              </div>
              <div className="whitespace-pre-wrap">{item.span}</div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
