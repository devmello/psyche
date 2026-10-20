import type {
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { FinishReason, ModelEvent } from "@psyche/protocol";
import type { OpaqueEnvelope, ProviderMetadata } from "./envelope.ts";
import { classifyError } from "./errors.ts";
import type { ToolNameMap } from "./tool-names.ts";

export interface StreamFinish {
  usage: LanguageModelV4Usage | undefined;
  reason: FinishReason;
  error?: string;
  metadata: ProviderMetadata | undefined;
}

function hasMetadata(m: unknown): m is ProviderMetadata {
  return typeof m === "object" && m !== null && Object.keys(m).length > 0;
}

function merge(a: ProviderMetadata | undefined, b: unknown): ProviderMetadata | undefined {
  if (!hasMetadata(b)) return a;
  const out: ProviderMetadata = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = { ...out[k], ...(v as Record<string, unknown>) };
  }
  return out;
}

export function mapFinishReason(reason: LanguageModelV4FinishReason): {
  reason: FinishReason;
  error?: string;
} {
  switch (reason.unified) {
    case "stop":
    case "other":
      return { reason: "stop" };
    case "length":
      return { reason: "length" };
    case "tool-calls":
      return { reason: "tool_calls" };
    case "content-filter":
      return { reason: "error", error: "content_filter: the provider withheld the response" };
    case "error":
      return {
        reason: "error",
        error: `server_error: provider finished with ${reason.raw ?? "error"}`,
      };
  }
}

function parseInput(raw: string): unknown {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Invalid JSON goes to the agent loop as a string so it can tell the model.
    return raw;
  }
}

/**
 * Turns AI SDK v4 stream parts into contract events. Stateful per call: reasoning blocks are
 * buffered until `reasoning-end` so the opaque envelope holds the whole block and its
 * signature; deltas are also emitted (`data: null`, `textDelta`) for live display.
 */
export class StreamConverter {
  readonly #providerId: string;
  readonly #model: string;
  readonly #reasoning = new Map<string, { text: string; metadata: ProviderMetadata | undefined }>();
  readonly #textMeta = new Map<string, ProviderMetadata | undefined>();
  readonly #providerCalls = new Map<
    string,
    { input: unknown; metadata: ProviderMetadata | undefined }
  >();
  finish: StreamFinish | undefined;
  /** True once any model-visible content (text, reasoning, tool call) was emitted. */
  contentStarted = false;

  readonly #toolNames: ToolNameMap | undefined;
  readonly #prefix: string | undefined;

  constructor(
    providerId: string,
    model: string,
    toolNames?: ToolNameMap,
    options: { thinkingPrefix?: string } = {},
  ) {
    this.#providerId = providerId;
    this.#model = model;
    this.#toolNames = toolNames;
    this.#prefix = options.thinkingPrefix;
  }

  #envelope(data: OpaqueEnvelope): ModelEvent {
    return { type: "reasoning", provider: this.#providerId, data };
  }

  /** Events for one part. Throws `ModelCallError` for `error` parts. */
  push(part: LanguageModelV4StreamPart): ModelEvent[] {
    switch (part.type) {
      case "text-start":
        this.#textMeta.set(part.id, merge(undefined, part.providerMetadata));
        return [];
      case "text-delta":
        this.#textMeta.set(part.id, merge(this.#textMeta.get(part.id), part.providerMetadata));
        if (part.delta.length === 0) return [];
        this.contentStarted = true;
        return [{ type: "text_delta", text: part.delta }];
      case "text-end": {
        const metadata = merge(this.#textMeta.get(part.id), part.providerMetadata);
        this.#textMeta.delete(part.id);
        if (metadata === undefined) return [];
        return [
          this.#envelope({
            v: 1,
            kind: "part-metadata",
            model: this.#model,
            part: "text",
            metadata,
          }),
        ];
      }
      case "reasoning-start":
        this.#reasoning.set(part.id, {
          text: "",
          metadata: merge(undefined, part.providerMetadata),
        });
        return [];
      case "reasoning-delta": {
        const block = this.#reasoning.get(part.id) ?? { text: "", metadata: undefined };
        block.text += part.delta;
        block.metadata = merge(block.metadata, part.providerMetadata);
        this.#reasoning.set(part.id, block);
        if (part.delta.length === 0) return [];
        this.contentStarted = true;
        return [
          { type: "reasoning", provider: this.#providerId, data: null, textDelta: part.delta },
        ];
      }
      case "reasoning-end": {
        const block = this.#reasoning.get(part.id) ?? { text: "", metadata: undefined };
        this.#reasoning.delete(part.id);
        const metadata = merge(block.metadata, part.providerMetadata);
        this.contentStarted = true;
        const env: OpaqueEnvelope = {
          v: 1,
          kind: "reasoning",
          model: this.#model,
          text: block.text,
        };
        if (metadata !== undefined) env.metadata = metadata;
        if (this.#prefix !== undefined) env.prefix = this.#prefix;
        return [this.#envelope(env)];
      }
      case "tool-call": {
        const input = parseInput(part.input);
        const metadata = merge(undefined, part.providerMetadata);
        if (part.providerExecuted === true) {
          this.#providerCalls.set(part.toolCallId, { input, metadata });
          return [];
        }
        this.contentStarted = true;
        const events: ModelEvent[] = [
          {
            type: "tool_call",
            id: part.toolCallId,
            name: this.#toolNames?.toOurs(part.toolName) ?? part.toolName,
            input,
          },
        ];
        if (metadata !== undefined) {
          events.push(
            this.#envelope({
              v: 1,
              kind: "part-metadata",
              model: this.#model,
              part: "tool_call",
              toolCallId: part.toolCallId,
              metadata,
            }),
          );
        }
        return events;
      }
      case "tool-result": {
        if (part.preliminary === true) return [];
        const call = this.#providerCalls.get(part.toolCallId);
        this.#providerCalls.delete(part.toolCallId);
        this.contentStarted = true;
        const env: OpaqueEnvelope = {
          v: 1,
          kind: "provider-tool",
          model: this.#model,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: call?.input ?? {},
          result: part.result,
        };
        if (part.isError === true) env.isError = true;
        const metadata = merge(call?.metadata, part.providerMetadata);
        if (metadata !== undefined) env.metadata = metadata;
        const result: ModelEvent = {
          type: "tool_result",
          callId: part.toolCallId,
          output: part.result,
        };
        if (part.isError === true) result.isError = true;
        return [this.#envelope(env), result];
      }
      case "finish": {
        const mapped = mapFinishReason(part.finishReason);
        this.finish = {
          usage: part.usage,
          reason: mapped.reason,
          metadata: merge(undefined, part.providerMetadata),
        };
        if (mapped.error !== undefined) this.finish.error = mapped.error;
        return [];
      }
      case "error":
        throw classifyError(part.error);
      default:
        // stream-start warnings, response metadata, tool-input-* deltas, sources, files, raw.
        return [];
    }
  }
}
