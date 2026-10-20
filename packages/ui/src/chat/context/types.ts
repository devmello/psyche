/**
 * What the chat's context UI shows (owner priority after #447). These view models follow the
 * agent-core brief for `threads.contextUsage`, `thread.context.updated` and compaction messages;
 * the connected wiring maps the protocol shapes onto them once they land (docs/status/s02.md).
 */

/** Where a turn's tokens go. */
export interface ContextBreakdown {
  systemPrompt: number;
  tools: number;
  /** Memory, persona files, daily notes and other injected context. */
  memory: number;
  history: number;
  currentMessage: number;
}

export interface ContextUsageView {
  /** Tokens the next model call carries. */
  used: number;
  /** The thread's context limit (`context.maxTokens`, or the model's context length). */
  limit: number;
  /** Compaction starts at this many tokens (`context.compactAt` × limit). */
  compactAt: number;
  /** True when the provider counted the tokens; false for an estimate. */
  exact: boolean;
  breakdown: ContextBreakdown;
}

/** A compaction message (kind "compaction") in the transcript. */
export interface CompactionView {
  id: string;
  tokensBefore: number;
  tokensAfter: number;
  /** How many earlier messages it replaced. */
  replacedCount: number;
  summaryMd: string;
  createdAt: string;
}

export const BREAKDOWN_LABEL: Record<keyof ContextBreakdown, string> = {
  systemPrompt: "System prompt",
  tools: "Tools",
  memory: "Memory and context",
  history: "Conversation so far",
  currentMessage: "Current message",
};

/** "12.4k", "200k", "1.2M": compact token counts for pills and markers. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return `${Math.round((n / 1_000_000) * 10) / 10}M`;
}

/** How close the context is to compaction: below 85% of the threshold, near it, or past it. */
export function contextTone(
  u: Pick<ContextUsageView, "used" | "compactAt">,
): "ok" | "near" | "over" {
  if (u.used >= u.compactAt) return "over";
  if (u.used >= u.compactAt * 0.85) return "near";
  return "ok";
}
