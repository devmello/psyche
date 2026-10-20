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
import { activeI18n, t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import {
  BREAKDOWN_KEYS,
  breakdownLabel,
  type ContextUsageView,
  contextTone,
  formatTokens,
  limitFromLabel,
} from "./types.ts";

const TONE = {
  ok: { bar: "bg-gray-9", text: "text-muted-foreground" },
  near: { bar: "bg-approval", text: "text-approval-text" },
  over: { bar: "bg-danger", text: "text-danger-text" },
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
  const label = t("context.meter.label", {
    used: usage.used,
    limit: usage.limit,
    pct,
    estimate: !usage.exact,
    tone,
  });
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
            className={cn("absolute inset-y-0 start-0 rounded-full", TONE[tone].bar)}
            style={{ width: `${pct}%` }}
          />
        </span>
        {usage.exact ? null : (
          <span
            className="rounded bg-gray-3 px-1 text-[0.6875rem] text-muted-foreground"
            aria-hidden="true"
          >
            {t("context.meter.estimateBadge")}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle>{t("context.meter.title")}</PopoverTitle>
          <PopoverDescription>
            {t("context.meter.usage", { used: usage.used, limit: usage.limit, pct })}{" "}
            {usage.exact ? t("context.meter.exact") : t("context.meter.estimated")}
            {usage.limitFrom
              ? ` ${t("context.meter.limitFrom", { from: limitFromLabel(usage.limitFrom) })}`
              : ""}
          </PopoverDescription>
        </PopoverHeader>
        <table className="mt-2 w-full text-sm" aria-label={t("context.meter.breakdownTable")}>
          <tbody>
            {BREAKDOWN_KEYS.map((k) => (
              <tr key={k}>
                <th scope="row" className="py-0.5 text-start font-normal text-muted-foreground">
                  {breakdownLabel(k)}
                </th>
                <td className="py-0.5 text-end tabular-nums">
                  {activeI18n().number(usage.breakdown[k])}
                </td>
                <td className="w-12 py-0.5 text-end text-xs text-muted-foreground tabular-nums">
                  {activeI18n().percent(percent(usage.breakdown[k], usage.used) / 100)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={cn("mt-2 text-xs", TONE[tone].text)}>
          {tone === "over"
            ? t("context.meter.past", { at: usage.compactAt })
            : t("context.meter.threshold", {
                at: usage.compactAt,
                pct: percent(usage.compactAt, usage.limit),
              })}
        </p>
        {onCompact || onEditLimits ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {onCompact ? (
              <Button type="button" size="sm" onClick={onCompact} disabled={compacting}>
                {compacting ? (
                  <Loader className="motion-safe:animate-spin" aria-hidden="true" />
                ) : null}
                {compacting ? t("context.meter.compacting") : t("context.meter.compactNow")}
              </Button>
            ) : null}
            {onEditLimits ? (
              <Button type="button" size="sm" variant="outline" onClick={onEditLimits}>
                {t("context.meter.editLimits")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
