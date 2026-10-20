import { Loader } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "../../components/ui/popover.tsx";
import { cn } from "../../lib/utils.ts";
import {
  BREAKDOWN_LABEL,
  type ContextBreakdown,
  type ContextUsageView,
  contextTone,
  formatTokens,
  LIMIT_FROM_LABEL,
} from "./types.ts";

const TONE = {
  ok: { bar: "bg-gray-9", text: "text-muted-foreground", words: "" },
  near: {
    bar: "bg-approval",
    text: "text-approval-text",
    words: ", near the compaction threshold",
  },
  over: { bar: "bg-danger", text: "text-danger-text", words: ", past the compaction threshold" },
} as const;

const percent = (part: number, whole: number) =>
  whole <= 0 ? 0 : Math.min(100, Math.round((part / whole) * 100));

export interface ContextMeterProps {
  usage: ContextUsageView;
  /** Compacts the thread now (`threads.compact`). */
  onCompact?: () => void;
  /** Opens this chat's own context limits. */
  onEditLimits?: () => void;
  compacting?: boolean;
}

/**
 * Context usage in the chat header: used of limit with a thin bar coloured by how close the
 * thread is to its compaction threshold, an "estimate" badge when the count isn't exact, and the
 * breakdown plus "Compact now" on click. State is in words too, never colour alone.
 */
export function ContextMeter({
  usage,
  onCompact,
  onEditLimits,
  compacting = false,
}: ContextMeterProps): ReactElement {
  const tone = contextTone(usage);
  const pct = percent(usage.used, usage.limit);
  const label = `Context: ${usage.used.toLocaleString()} of ${usage.limit.toLocaleString()} tokens, ${pct}%${
    usage.exact ? "" : ", estimate"
  }${TONE[tone].words}`;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border border-gray-6 px-2.5 text-xs hover:bg-gray-3 focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <span className={cn("tabular-nums", TONE[tone].text)} aria-hidden="true">
          {formatTokens(usage.used)} / {formatTokens(usage.limit)}
        </span>
        <span
          className="relative h-1.5 w-10 overflow-hidden rounded-full bg-gray-4"
          aria-hidden="true"
        >
          <span
            className={cn("absolute inset-y-0 left-0 rounded-full", TONE[tone].bar)}
            style={{ width: `${pct}%` }}
          />
        </span>
        {usage.exact ? null : (
          <span
            className="rounded bg-gray-3 px-1 text-[0.6875rem] text-muted-foreground"
            aria-hidden="true"
          >
            estimate
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle>Context</PopoverTitle>
          <PopoverDescription>
            {usage.used.toLocaleString()} of {usage.limit.toLocaleString()} tokens ({pct}%).{" "}
            {usage.exact ? "Counted by the provider." : "An estimate until the provider counts it."}
            {usage.limitFrom ? ` The limit is ${LIMIT_FROM_LABEL[usage.limitFrom]}.` : ""}
          </PopoverDescription>
        </PopoverHeader>
        <table className="mt-2 w-full text-sm" aria-label="Where the tokens go">
          <tbody>
            {(Object.keys(BREAKDOWN_LABEL) as (keyof ContextBreakdown)[]).map((k) => (
              <tr key={k}>
                <th scope="row" className="py-0.5 text-left font-normal text-muted-foreground">
                  {BREAKDOWN_LABEL[k]}
                </th>
                <td className="py-0.5 text-right tabular-nums">
                  {usage.breakdown[k].toLocaleString()}
                </td>
                <td className="w-12 py-0.5 text-right text-xs text-muted-foreground tabular-nums">
                  {percent(usage.breakdown[k], usage.used)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={cn("mt-2 text-xs", TONE[tone].text)}>
          {tone === "over"
            ? `Past the compaction threshold (${usage.compactAt.toLocaleString()} tokens): earlier turns are summarised before the next reply.`
            : `Earlier turns are summarised at ${usage.compactAt.toLocaleString()} tokens (${percent(usage.compactAt, usage.limit)}% of the limit).`}
        </p>
        {onCompact || onEditLimits ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {onCompact ? (
              <Button type="button" size="sm" onClick={onCompact} disabled={compacting}>
                {compacting ? (
                  <Loader className="motion-safe:animate-spin" aria-hidden="true" />
                ) : null}
                {compacting ? "Compacting…" : "Compact now"}
              </Button>
            ) : null}
            {onEditLimits ? (
              <Button type="button" size="sm" variant="outline" onClick={onEditLimits}>
                Limits for this chat…
              </Button>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
