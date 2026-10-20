import { ChevronRight, Shrink } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { Markdown } from "../../blocks/Markdown.tsx";
import { Button } from "../../components/ui/button.tsx";
import { cn } from "../../lib/utils.ts";
import { type CompactionView, formatTokens } from "./types.ts";

export interface CompactionMarkerProps {
  compaction: CompactionView;
  /** Shows the messages the summary replaced (loaded on request); absent hides the action. */
  onShowReplaced?: () => void;
  /** The replaced messages once loaded, rendered under the summary. */
  replaced?: ReactNode;
  /** Stories: start expanded. */
  defaultOpen?: boolean;
}

/**
 * Where earlier messages were compacted: "Earlier messages were compacted, 48.2k → 3.1k tokens",
 * expanding to the summary the model now reads, and offering what was replaced.
 */
export function CompactionMarker({
  compaction: c,
  onShowReplaced,
  replaced,
  defaultOpen = false,
}: CompactionMarkerProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section
      aria-label="Compacted messages"
      className="my-3 rounded-lg border border-dashed border-gray-6 px-3 py-2 text-sm"
      data-testid="compaction-marker"
    >
      <button
        type="button"
        className="flex min-h-6 w-full items-center gap-2 text-left text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        aria-controls={`${id}-summary`}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
        <Shrink className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          {c.replacedCount === 1
            ? "An earlier message was"
            : `${c.replacedCount} earlier messages were`}{" "}
          compacted, {formatTokens(c.tokensBefore)} → {formatTokens(c.tokensAfter)} tokens
        </span>
      </button>
      {open ? (
        <div id={`${id}-summary`} className="mt-2 flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">The summary the agent reads instead:</p>
          <Markdown className="rounded-md bg-gray-2 p-2">{c.summaryMd}</Markdown>
          {replaced ??
            (onShowReplaced ? (
              <div>
                <Button type="button" variant="ghost" size="sm" onClick={onShowReplaced}>
                  Show what was replaced
                </Button>
              </div>
            ) : null)}
        </div>
      ) : null}
    </section>
  );
}
