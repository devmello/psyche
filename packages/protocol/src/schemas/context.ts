import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, ModelRef } from "../common.ts";

/**
 * Context usage and limits per thread (features B7, C2; data model §2 `runs.usage`). After every
 * turn the Gateway records what the turn's last model call sent: the provider's exact input
 * tokens when it reports them (`estimated: false`), else the router's estimate. The breakdown
 * splits that total by where the tokens came from (estimated per part, scaled to the total).
 */

const Tokens = Type.Integer({ minimum: 0 });

export const ContextBreakdown = Type.Object(
  {
    system: Tokens,
    tools: Tokens,
    /** Memory, persona files, skills index, daily notes, context providers, plugin sections. */
    context: Tokens,
    /** Earlier turns, including any compaction summary. */
    history: Tokens,
    /** The current turn: the owner's message and this turn's tool calls and results. */
    current: Tokens,
  },
  { $id: "ContextBreakdown" },
);
export type ContextBreakdown = Static<typeof ContextBreakdown>;

/** Owner-set limits; any field absent falls back to the next level (thread → settings → model). */
export const ContextLimits = Type.Object(
  {
    /** The most prompt tokens a turn may send; the loop refuses to go over. */
    maxTokens: Type.Optional(Type.Integer({ minimum: 1_000 })),
    /** Compact when the next call would pass this share of `maxTokens`. */
    compactAt: Type.Optional(Type.Number({ minimum: 0.2, maximum: 0.95 })),
    /** Owner turns kept verbatim after a compaction. */
    keepRecentTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { $id: "ContextLimits" },
);
export type ContextLimits = Static<typeof ContextLimits>;

/** Limits with every field resolved, and where `maxTokens` came from. */
export const EffectiveContextLimits = Type.Object(
  {
    maxTokens: Type.Integer({ minimum: 1_000 }),
    compactAt: Type.Number(),
    keepRecentTurns: Type.Integer({ minimum: 1 }),
    /** The model's context window (router capability metadata, or the default). */
    contextWindow: Type.Integer({ minimum: 1 }),
    maxTokensFrom: Type.Union([
      Type.Literal("thread"),
      Type.Literal("settings"),
      Type.Literal("model"),
    ]),
  },
  { $id: "EffectiveContextLimits" },
);
export type EffectiveContextLimits = Static<typeof EffectiveContextLimits>;

export const ContextUsage = Type.Object(
  {
    threadId: Id,
    runId: Id,
    model: ModelRef,
    at: IsoDateTime,
    /** Prompt tokens of the turn's last model call (input + cache read + cache write). */
    promptTokens: Tokens,
    /** True when the provider reported no input tokens and this is the router's estimate. */
    estimated: Type.Boolean(),
    breakdown: ContextBreakdown,
    /** The largest prompt of any call in the turn. */
    peakTokens: Tokens,
    limits: EffectiveContextLimits,
    /** Compactions in this thread so far. */
    compactions: Tokens,
  },
  { $id: "ContextUsage" },
);
export type ContextUsage = Static<typeof ContextUsage>;

/** What a compaction keeps of the summarized turns (utility model, structured). */
export const CompactionSummary = Type.Object(
  {
    facts: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 40 }),
    decisions: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 40 }),
    openTasks: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 40 }),
    /** Standing instructions the owner gave ("always…", "never…", formats, names). */
    pinnedInstructions: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 40 }),
  },
  { $id: "CompactionSummary" },
);
export type CompactionSummary = Static<typeof CompactionSummary>;

export const CompactionResult = Type.Object(
  {
    compactionId: Id,
    /** The thread message holding the `compaction` block. */
    messageId: Id,
    tokensBefore: Tokens,
    tokensAfter: Tokens,
    replacedTurns: Tokens,
  },
  { $id: "CompactionResult" },
);
export type CompactionResult = Static<typeof CompactionResult>;
