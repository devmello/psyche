import type {
  Block,
  ContextBreakdown,
  ContextUsage,
  EffectiveContextLimits,
} from "@psyche/protocol";
import { activeI18n, t } from "../../i18n/core.ts";

/**
 * What the chat's context UI shows. The view models are the protocol's `threads.contextUsage`,
 * `thread.context.updated` and `compaction` block shapes (docs/status/s02.md), flattened for the
 * meter and the marker by `usageView` and `compactionView`.
 */

export type { ContextBreakdown };

export type CompactionBlock = Extract<Block, { type: "compaction" }>;

export interface ContextUsageView {
  /** Prompt tokens of the last turn's last model call. */
  used: number;
  /** The thread's context limit (`maxTokens`: thread, settings or the model's window). */
  limit: number;
  /** Where the limit comes from. */
  limitFrom?: EffectiveContextLimits["maxTokensFrom"];
  /** Compaction starts at this many tokens (`compactAt` × limit). */
  compactAt: number;
  /** True when the provider counted the tokens; false for an estimate. */
  exact: boolean;
  breakdown: ContextBreakdown;
}

export type CompactionSummary = CompactionBlock["summary"];

/** A compaction (a `compaction` block in a system message) in the transcript. */
export interface CompactionView {
  id: string;
  trigger: "auto" | "manual";
  tokensBefore: number;
  tokensAfter: number;
  /** How many earlier turns it replaced (they stay in the transcript). */
  replacedTurns: number;
  /** The utility model's plain-text summary, never Markdown. */
  summary: CompactionSummary;
  createdAt: string;
}

export const BREAKDOWN_KEYS = ["system", "tools", "context", "history", "current"] as const;
export const SUMMARY_KEYS = ["facts", "decisions", "openTasks", "pinnedInstructions"] as const;

export const breakdownLabel = (k: keyof ContextBreakdown): string => t(`context.breakdown.${k}`);
export const summaryLabel = (k: keyof CompactionSummary): string => t(`context.summary.${k}`);
export const limitFromLabel = (from: EffectiveContextLimits["maxTokensFrom"]): string =>
  t(`context.limitFrom.${from}`);

/** The meter's view of a turn's usage under the thread's effective limits. */
export function usageView(
  usage: ContextUsage,
  limits: EffectiveContextLimits = usage.limits,
): ContextUsageView {
  return {
    used: usage.promptTokens,
    limit: limits.maxTokens,
    limitFrom: limits.maxTokensFrom,
    compactAt: Math.round(limits.maxTokens * limits.compactAt),
    exact: !usage.estimated,
    breakdown: usage.breakdown,
  };
}

export function compactionView(block: CompactionBlock, createdAt: string): CompactionView {
  return {
    id: block.compactionId,
    trigger: block.trigger,
    tokensBefore: block.tokensBefore,
    tokensAfter: block.tokensAfter,
    replacedTurns: block.replaced.turns,
    summary: block.summary,
    createdAt,
  };
}

/** "12.4k", "200k", "1.2M": compact token counts for pills and markers. */
export function formatTokens(n: number): string {
  const num = (v: number) => activeI18n().number(v, { maximumFractionDigits: 1 });
  if (n < 1000) return num(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${num(k >= 100 ? Math.round(k) : Math.round(k * 10) / 10)}k`;
  }
  return `${num(Math.round((n / 1_000_000) * 10) / 10)}M`;
}

/** How close the context is to compaction: below 85% of the threshold, near it, or past it. */
export function contextTone(
  u: Pick<ContextUsageView, "used" | "compactAt">,
): "ok" | "near" | "over" {
  if (u.used >= u.compactAt) return "over";
  if (u.used >= u.compactAt * 0.85) return "near";
  return "ok";
}
