import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ModelCallOptions,
  ModelEvent,
  ModelPart,
  ModelProvider,
  ModelRequest,
} from "@psyche/protocol";

/**
 * A live Haiku provider for evals and re-recordings, never for CI (docs say live runs happen on
 * demand). It speaks the Messages API through `fetch`, non-streaming, and is pinned to ONE model:
 * every request goes to `claude-haiku-5-5` whatever `request.model` says. The key is
 * `ANTHROPIC_API_KEY` from the environment or the nearest `.env` up the tree; it is only ever
 * placed in a request header (`temperature` is not sent: the model rejects it) and is never printed, logged or put in an error message.
 */

export const LIVE_HAIKU_MODEL = "claude-haiku-5-5";

export function loadAnthropicKey(startDir: string = process.cwd()): string {
  let key = process.env.ANTHROPIC_API_KEY;
  for (let dir = startDir; key === undefined || key === ""; dir = dirname(dir)) {
    const file = join(dir, ".env");
    if (existsSync(file)) {
      const m = readFileSync(file, "utf8").match(/^ANTHROPIC_API_KEY=(.*)$/m);
      if (m?.[1]) key = m[1].trim().replace(/^["']|["']$/g, "");
    }
    if (dirname(dir) === dir) break;
  }
  if (key === undefined || key === "") throw new Error("ANTHROPIC_API_KEY is not set");
  return key;
}

export interface LiveUsage {
  calls: number;
  input: number;
  output: number;
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

function toBlocks(parts: readonly ModelPart[]): Block[] {
  return parts.flatMap((p): Block[] => {
    if (p.type === "text") return [{ type: "text", text: p.text }];
    if (p.type === "tool_call")
      return [{ type: "tool_use", id: p.id, name: p.name, input: p.input }];
    if (p.type === "tool_result")
      return [
        {
          type: "tool_result",
          tool_use_id: p.callId,
          content: typeof p.output === "string" ? p.output : JSON.stringify(p.output),
          ...(p.isError === true ? { is_error: true } : {}),
        },
      ];
    return [];
  });
}

function toolChoice(c: ModelRequest["toolChoice"]): { tool_choice?: object } {
  if (c === undefined) return {};
  if (c === "none") return { tool_choice: { type: "none" } };
  if (c === "required") return { tool_choice: { type: "any" } };
  if (c === "auto") return { tool_choice: { type: "auto" } };
  return { tool_choice: { type: "tool", name: c.tool } };
}

export function createLiveHaikuProvider(
  opts: { apiKey?: string; maxRetries?: number } = {},
): ModelProvider & { readonly usage: LiveUsage } {
  const usage: LiveUsage = { calls: 0, input: 0, output: 0 };
  const apiKey = opts.apiKey ?? loadAnthropicKey();
  const maxRetries = opts.maxRetries ?? 4;
  return {
    id: "anthropic",
    usage,
    capabilities: async () => ({
      toolCalling: true,
      vision: false,
      reasoning: false,
      embeddings: false,
    }),
    async *stream(request: ModelRequest, options?: ModelCallOptions): AsyncIterable<ModelEvent> {
      const body = {
        model: LIVE_HAIKU_MODEL,
        max_tokens: request.maxOutputTokens ?? 1024,
        ...(request.system === undefined ? {} : { system: request.system }),
        messages: request.messages.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: toBlocks(m.parts),
        })),
        ...(request.tools === undefined || request.tools.length === 0
          ? {}
          : {
              tools: request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
              })),
              ...toolChoice(request.toolChoice),
            }),
      };
      for (let attempt = 0; ; attempt++) {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        if (!res.ok) {
          const detail = ((await res.json().catch(() => ({}))) as { error?: { message?: string } })
            .error?.message;
          yield {
            type: "finish",
            reason: "error",
            error: `anthropic ${res.status}${detail === undefined ? "" : `: ${detail}`}`,
          };
          return;
        }
        const json = (await res.json()) as {
          content: Block[];
          stop_reason?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        usage.calls++;
        usage.input += json.usage?.input_tokens ?? 0;
        usage.output += json.usage?.output_tokens ?? 0;
        for (const b of json.content) {
          if (b.type === "text") yield { type: "text_delta", text: b.text };
          if (b.type === "tool_use")
            yield { type: "tool_call", id: b.id, name: b.name, input: b.input };
        }
        yield {
          type: "usage",
          usage: {
            input: json.usage?.input_tokens ?? 0,
            output: json.usage?.output_tokens ?? 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            costUsd: 0,
          },
        };
        yield {
          type: "finish",
          reason:
            json.stop_reason === "tool_use"
              ? "tool_calls"
              : json.stop_reason === "max_tokens"
                ? "length"
                : "stop",
        };
        return;
      }
    },
  };
}
