import type { JsonObject, ModelRef, ProvenanceOut, Usage } from "../common.ts";
import type { ToolSpec } from "../schemas/tools.ts";
import type { CallOptions } from "./Clock.ts";

/**
 * Model provider contract (architecture §4.4, ADR-003). One implementation per provider family
 * (AI SDK v7 provider packages behind the model router, S03). Requests and events are
 * provider-neutral; provider-native data (signed reasoning, cache markers) travels opaquely and
 * is round-tripped verbatim (architecture §4.2 step 3).
 */

/** One part of a normalized message. */
export type ModelPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data?: string; url?: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      callId: string;
      name?: string;
      output: unknown;
      isError?: boolean;
      /** Results tagged `untrusted` are data, never instructions (security §3.6). */
      provenance?: ProvenanceOut;
    }
  /** Opaque provider-native reasoning. Never edited, summarized or re-ordered. */
  | { type: "reasoning"; provider: string; data: unknown };

export type ModelMessageRole = "user" | "assistant" | "tool";

export interface ModelMessage {
  role: ModelMessageRole;
  parts: ModelPart[];
}

export interface ModelRequest {
  model: ModelRef;
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none" | "required" | { tool: string };
  maxOutputTokens?: number;
  temperature?: number;
  /** Keyed by provider id, passed through untouched (e.g. `{anthropic: {thinking: …}}`). */
  providerOptions?: Record<string, JsonObject>;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "error" | "cancelled";

/**
 * Stream events. Invariant every implementation keeps: exactly one `finish`, and it is the
 * last event; cancellation via the signal ends the stream with `finish{reason:"cancelled"}`
 * instead of throwing.
 */
export type ModelEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "reasoning";
      provider: string;
      data: unknown;
      /** Streamed reasoning text, shown as a step (never part of the round-trip data). */
      textDelta?: string;
      /** A provider summary of the reasoning, when it gives no streamed text. */
      summary?: string;
    }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  /** Result of a provider-executed (server-side) tool. */
  | { type: "tool_result"; callId: string; output: unknown; isError?: boolean }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: FinishReason; error?: string };

export interface ModelCapabilities {
  toolCalling: boolean;
  vision: boolean;
  reasoning: boolean;
  embeddings: boolean;
  promptCaching?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface EmbedOptions extends CallOptions {
  model?: ModelRef;
}

/**
 * Per-call context for a model request. `threadId` lets the model router apply that thread's
 * `/model` pin (strict for `router/primary`, architecture §4.4) and attribute usage; `runId`
 * attributes usage to a run. Providers that do not care ignore both.
 */
export interface ModelCallOptions extends CallOptions {
  threadId?: string;
  runId?: string;
}

export interface ModelProvider {
  /** Provider id, the part of a `ModelRef` before the slash. */
  readonly id: string;
  stream(request: ModelRequest, options?: ModelCallOptions): AsyncIterable<ModelEvent>;
  embed?(texts: string[], options?: EmbedOptions): Promise<number[][]>;
  capabilities(model?: ModelRef): Promise<ModelCapabilities>;
}
