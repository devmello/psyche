import { ChevronRight, Loader, Shrink } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import { type CompactionView, formatTokens, SUMMARY_KEYS, summaryLabel } from "./types.ts";

/** Stable list keys for summary lines: the text itself, suffixed only when a line repeats. */
function withUniqueKeys(items: readonly string[]): [string, string][] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const n = seen.get(item) ?? 0;
    seen.set(item, n + 1);
    return [n === 0 ? item : `${item}#${n}`, item];
  });
}

export interface CompactionMarkerProps {
  compaction: CompactionView;
  /** Shows the turns the summary replaced (loaded on request); absent hides the action. */
  onShowReplaced?: () => void;
  /** True while the replaced turns load. */
  loadingReplaced?: boolean;
  /** The replaced turns once loaded, rendered under the summary. */
  replaced?: ReactNode;
  /** Stories: start expanded. */
  defaultOpen?: boolean;
}

/**
 * Where earlier turns were compacted: "12 earlier turns were compacted, 48.2k → 3.1k tokens",
 * expanding to the structured summary the model now reads (facts, decisions, open tasks,
 * standing instructions; plain text) and offering the turns it replaced, which stay in the
 * transcript.
 */
export function CompactionMarker({
  compaction: c,
  onShowReplaced,
  loadingReplaced = false,
  replaced,
  defaultOpen = false,
}: CompactionMarkerProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const sections = SUMMARY_KEYS.filter((k) => c.summary[k].length > 0);
  return (
    <section
      aria-label={t("context.marker.region")}
      className="my-3 rounded-lg border border-dashed border-gray-6 px-3 py-2 text-start text-sm"
      data-testid="compaction-marker"
    >
      <button
        type="button"
        className="flex min-h-6 w-full items-center gap-2 text-start text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        aria-controls={`${id}-summary`}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open ? "rotate-90" : "rtl:rotate-180",
          )}
          aria-hidden="true"
        />
        <Shrink className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          {t("context.marker.toggle", {
            turns: c.replacedTurns,
            manual: c.trigger === "manual",
            before: formatTokens(c.tokensBefore),
            after: formatTokens(c.tokensAfter),
          })}
        </span>
      </button>
      {open ? (
        <div id={`${id}-summary`} className="mt-2 flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">{t("context.marker.readsInstead")}</p>
          <div className="flex flex-col gap-2 rounded-md bg-gray-2 p-2">
            {sections.length === 0 ? (
              <p className="text-muted-foreground">{t("context.marker.empty")}</p>
            ) : (
              sections.map((k) => (
                <div key={k}>
                  <p id={`${id}-${k}`} className="text-xs font-medium text-muted-foreground">
                    {summaryLabel(k)}
                  </p>
                  <ul aria-labelledby={`${id}-${k}`} className="ms-4 list-disc">
                    {withUniqueKeys(c.summary[k]).map(([key, item]) => (
                      <li key={key} className="whitespace-pre-wrap">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
          {replaced ??
            (onShowReplaced ? (
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onShowReplaced}
                  disabled={loadingReplaced}
                >
                  {loadingReplaced ? (
                    <Loader className="motion-safe:animate-spin" aria-hidden="true" />
                  ) : null}
                  {t("context.marker.showReplaced")}
                </Button>
              </div>
            ) : null)}
        </div>
      ) : null}
    </section>
  );
}
