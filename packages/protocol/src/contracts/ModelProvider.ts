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
  | {
      type: "text";
      text: string;
      /**
       * `untrusted` on text the owner did not write that sits in a user turn (recalled chats and
       * artifacts, a compaction summary of untrusted content). A run that replays it is tainted.
       * Providers ignore it.
       */
      provenance?: ProvenanceOut;
      /**
       * `owner` on the words the owner typed themselves in a user turn. Set only by the loop, for
       * a turn with no requester or an owner requester, `ownerWords` not false, no parent run
       * and no task. Never on attachment text, quoted context, a non-owner's message, an agent's
       * message, a widget act, a subagent brief or a task goal. It must never be settable from
       * client RPC params, tool or MCP output, or restored state: the loop and the thread
       * rebuild write it, and `ThreadState` loaded from storage is trusted as is. Older stored
       * messages lack it: absent means "not marked", not "not the owner's". Providers ignore it.
       */
      author?: "owner";
      /**
       * Extracted text of a file the owner attached themselves. Data, not instructions: quoted
       * apart from the owner's words and never a source of standing instructions, but it does
       * not taint the run or a summary (third-party files carry `provenance: "untrusted"`).
       * Providers ignore it.
       */
      ownerFile?: true;
      /**
       * Context the loop added to a user turn for that run only (turn context providers). The next
       * run replaces it with a fixed stub; a run that is not the owner's own never sees it.
       */
      turnContext?: true;
    }
  | {
      type: "image";
      mime: string;
      data?: string;
      url?: string;
      /**
       * `untrusted` on an image a third party made or that shows a third party's content (a
       * released download, a screen capture, an agent-written picture): what is written in it is
       * data. A run that replays it is tainted. Providers ignore it.
       */
      provenance?: ProvenanceOut;
    }
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
  /**
   * A user turn that brought third-party content in beyond its tagged parts (the run's input
   * taint: a screen capture, Ask about this, a widget, forwarded text). Compaction and replay treat
   * the whole turn as untrusted. Set only by the loop and the thread rebuild. Providers ignore it.
   */
  untrusted?: true;
  /**
   * On a tool message: the owner's own words, typed in the chat, that closed the waits these
   * results answer (a question answered in the chat, a card declined by typing). Set only by the
   * loop, with the text the owner sent. Providers ignore it.
   */
  ownerReply?: string;
}

export interface ModelRequest {
  model: ModelRef;
  system?: string;
  /**
   * Length of the leading part of `system` that stays the same from one owner turn to the next
   * (base prompt, persona, skills index, tool guidance). The rest follows after a blank line
   * (`system === stable + "\n\n" + volatile`): daily notes, the compaction summary and per-turn
   * context. A provider with prompt caching sends the two parts as separate cached blocks;
   * every other provider reads `system` whole.
   */
  systemStableLength?: number;
  messages: ModelMessage[];
  tools?: ToolSpec[];
  /**
   * Every tool this run loads on demand, loaded or not, in registration order. The loaded ones
   * are also in `tools`. A provider with deferred tool loading (Anthropic `defer_loading`) sends
   * all of them, so a load never changes the request prefix; every other provider ignores this
   * and sends `tools`.
   */
  deferredTools?: ToolSpec[];
  toolChoice?: "auto" | "none" | "required" | { tool: string };
  maxOutputTokens?: number;
  temperature?: number;
  /**
   * Reasoning depth for models that take it (Anthropic `output_config.effort`; other providers
   * ignore it). One-shot background jobs ask for `low`: the default is `medium` or `high`, and
   * thinking tokens are billed as output. Keep it constant within a thread (a change mid-thread
   * invalidates Anthropic's message cache).
   */
  effort?: "low" | "medium" | "high";
  /**
   * `off` turns thinking off where the model allows it (Haiku 5.5, Sonnet 5.5 via
   * `between_tools`, the 4.x models) so it cannot eat a small `maxOutputTokens`. Models that
   * cannot switch it off (Opus 5.5, Fable) keep their thinking and rely on `effort`.
   */
  reasoning?: "off";
  /**
   * Anthropic cache breakpoints. Unset: marked as usual (tools, system prompt, last message).
   * `none`: nothing is marked, for a one-shot call whose last message is unique and never read
   * again (the write premium would be paid for nothing).
   */
  cache?: "none";
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
  /** A piece of a tool call's input as the model writes it (only for tools that draw progressively). */
  | { type: "tool_input"; id: string; name: string; delta: string }
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
