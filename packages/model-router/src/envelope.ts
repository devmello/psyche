import type { ModelEvent, ModelMessage, ModelPart } from "@psyche/protocol";

/** Provider metadata as the AI SDK carries it: `{ <providerKey>: { …json } }`. */
export type ProviderMetadata = Record<string, Record<string, unknown>>;

/**
 * What a `reasoning` event's `data` holds when this package produced it. The agent loop stores
 * it untouched (architecture §4.2 step 3) and hands it back in the next request as a
 * `reasoning` part. Envelopes are tagged with the adapter id and model so a fallback to another
 * provider or model drops them instead of sending one vendor's signatures to another.
 */
export type OpaqueEnvelope =
  | {
      v: 1;
      kind: "reasoning";
      model: string;
      text: string;
      metadata?: ProviderMetadata;
    }
  | {
      /** Metadata that belongs to a non-reasoning part (Gemini signatures on tool calls). */
      v: 1;
      kind: "part-metadata";
      model: string;
      part: "tool_call" | "text";
      toolCallId?: string;
      metadata: ProviderMetadata;
    }
  | {
      /** A provider-executed (server-side) tool call and its result, kept for round-tripping. */
      v: 1;
      kind: "provider-tool";
      model: string;
      toolCallId: string;
      toolName: string;
      input?: unknown;
      result?: unknown;
      isError?: boolean;
      metadata?: ProviderMetadata;
    };

export function isEnvelope(data: unknown): data is OpaqueEnvelope {
  if (typeof data !== "object" || data === null) return false;
  const d = data as { v?: unknown; kind?: unknown; model?: unknown };
  return (
    d.v === 1 &&
    typeof d.model === "string" &&
    (d.kind === "reasoning" || d.kind === "part-metadata" || d.kind === "provider-tool")
  );
}

/**
 * Builds the assistant message for the transcript from a model stream, in arrival order:
 * consecutive `text_delta`s merge into one text part, each completed reasoning block (a
 * `reasoning` event with non-null `data`) becomes one `reasoning` part, tool calls become
 * `tool_call` parts. Streaming-only reasoning deltas (`data: null`, `textDelta` set) are for
 * live display and are not stored. Provider-executed tool results are not stored here: their
 * envelope already carries them.
 */
export class TurnAccumulator {
  readonly parts: ModelPart[] = [];
  finish: Extract<ModelEvent, { type: "finish" }> | undefined;

  push(event: ModelEvent): void {
    switch (event.type) {
      case "text_delta": {
        if (event.text.length === 0) return;
        const last = this.parts.at(-1);
        if (last?.type === "text") last.text += event.text;
        else this.parts.push({ type: "text", text: event.text });
        return;
      }
      case "reasoning":
        if (event.data !== null && event.data !== undefined) {
          this.parts.push({ type: "reasoning", provider: event.provider, data: event.data });
        }
        return;
      case "tool_call":
        this.parts.push({ type: "tool_call", id: event.id, name: event.name, input: event.input });
        return;
      case "finish":
        this.finish = event;
        return;
      default:
        return;
    }
  }

  /** The assistant message so far. */
  message(): ModelMessage {
    return { role: "assistant", parts: structuredClone(this.parts) };
  }

  toolCalls(): Extract<ModelPart, { type: "tool_call" }>[] {
    return this.parts.filter((p): p is Extract<ModelPart, { type: "tool_call" }> => p.type === "tool_call");
  }

  text(): string {
    return this.parts
      .filter((p): p is Extract<ModelPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("");
  }
}

/** Drain a stream into a `TurnAccumulator`. */
export async function accumulate(stream: AsyncIterable<ModelEvent>): Promise<TurnAccumulator> {
  const acc = new TurnAccumulator();
  for await (const event of stream) acc.push(event);
  return acc;
}
