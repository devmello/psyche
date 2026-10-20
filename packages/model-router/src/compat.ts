import type { ProviderKind } from "./config.ts";

/**
 * Wire quirks of the OpenAI-compatible local servers (llama.cpp `llama-server`, LM Studio),
 * fixed at the HTTP boundary so `@ai-sdk/openai-compatible` sees plain OpenAI Chat
 * Completions. Request fixes run in the package's `transformRequestBody`; stream fixes rewrite
 * the SSE body of `/chat/completions` responses.
 */

type Body = Record<string, unknown>;
type WireTool = { type?: string; function?: { name?: string } };

/**
 * `tool_choice: {type: "function", function: {name}}` → `"required"` with only that tool sent.
 * llama-server reads `tool_choice` as a string (`auto` / `none` / `required`) and silently
 * treats an object as `auto`, so a forced tool would be ignored; LM Studio documents only the
 * strings. The rewrite means the same thing on both.
 */
function namedToolChoiceToRequired(body: Body): void {
  const choice = body.tool_choice as { type?: string; function?: { name?: string } } | undefined;
  if (typeof choice !== "object" || choice === null || choice.type !== "function") return;
  const name = choice.function?.name;
  const tools = Array.isArray(body.tools) ? (body.tools as WireTool[]) : [];
  body.tools = tools.filter((t) => t.function?.name === name);
  body.tool_choice = "required";
}

/** Assistant turns that only call tools go out with `content: ""` (older templates need a string). */
function assistantContentString(body: Body): void {
  if (!Array.isArray(body.messages)) return;
  for (const m of body.messages as Body[]) {
    if (m.role === "assistant" && (m.content === null || m.content === undefined)) m.content = "";
  }
}

export function transformCompatRequest(kind: ProviderKind, body: Body): Body {
  const out: Body = { ...body };
  if (kind === "llamacpp" || kind === "lmstudio") {
    namedToolChoiceToRequired(out);
    assistantContentString(out);
  }
  return out;
}

interface WireToolCallDelta {
  index?: number;
  id?: string | null;
  type?: string;
  function?: { name?: string | null; arguments?: unknown };
}

interface Timings {
  prompt_n?: number;
  predicted_n?: number;
  cache_n?: number;
}

/**
 * Per-response state for the stream fixes:
 * - parallel tool calls that reuse one `index` with different `id`s (seen from llama-server
 *   chat templates) get distinct indices, so their arguments are not glued together;
 * - `function.arguments` sent as a JSON object is stringified;
 * - an empty-string `id` on a continuation delta is dropped;
 * - `finish_reason: "stop"` after tool calls becomes `"tool_calls"`;
 * - a final chunk with llama.cpp `timings` but no `usage` gets `usage` built from them.
 */
export class CompatStreamFixer {
  readonly #byId = new Map<string, number>();
  readonly #current = new Map<number, number>();
  readonly #used = new Set<number>();
  #lastOrig: number | undefined;
  #sawToolCalls = false;
  #sawUsage = false;

  fixChunk(chunk: Body): Body {
    const choices = Array.isArray(chunk.choices) ? (chunk.choices as Body[]) : [];
    for (const choice of choices) {
      const delta = choice.delta as { tool_calls?: WireToolCallDelta[] } | undefined;
      for (const tc of delta?.tool_calls ?? []) this.#fixToolCall(tc);
      if (choice.finish_reason === "stop" && this.#sawToolCalls)
        choice.finish_reason = "tool_calls";
    }
    if (chunk.usage !== undefined && chunk.usage !== null) this.#sawUsage = true;
    const timings = chunk.timings as Timings | undefined;
    if (!this.#sawUsage && typeof timings === "object" && timings !== null) {
      const cached = timings.cache_n ?? 0;
      const prompt = (timings.prompt_n ?? 0) + cached;
      const completion = timings.predicted_n ?? 0;
      chunk.usage = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        prompt_tokens_details: { cached_tokens: cached },
      };
      this.#sawUsage = true;
    }
    return chunk;
  }

  #fixToolCall(tc: WireToolCallDelta): void {
    this.#sawToolCalls = true;
    if (tc.id === "" || tc.id === null) delete tc.id;
    const args = tc.function?.arguments;
    if (tc.function !== undefined && args !== undefined && typeof args !== "string") {
      tc.function.arguments = JSON.stringify(args);
    }
    const orig = tc.index ?? this.#lastOrig ?? 0;
    if (tc.id !== undefined) {
      let mapped = this.#byId.get(tc.id);
      if (mapped === undefined) {
        mapped = this.#used.has(orig) ? Math.max(...this.#used) + 1 : orig;
        this.#used.add(mapped);
        this.#byId.set(tc.id, mapped);
      }
      this.#current.set(orig, mapped);
    } else if (!this.#current.has(orig)) {
      this.#used.add(orig);
      this.#current.set(orig, orig);
    }
    tc.index = this.#current.get(orig) ?? orig;
    this.#lastOrig = orig;
  }
}

/** Rewrite every `data: {json}` event of an SSE byte stream through `fix`. */
export function rewriteSse(
  body: ReadableStream<Uint8Array>,
  fix: (data: Body) => Body,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const line = (raw: string): string => {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!text.startsWith("data:")) return text;
    const payload = text.slice(5).trim();
    if (!payload.startsWith("{")) return text;
    try {
      return `data: ${JSON.stringify(fix(JSON.parse(payload) as Body))}`;
    } catch {
      return text;
    }
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        if (parts.length > 0) controller.enqueue(encoder.encode(`${parts.map(line).join("\n")}\n`));
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.length > 0) controller.enqueue(encoder.encode(line(buffer)));
      },
    }),
  );
}

/**
 * LM Studio answers some failures with `{"error": "message"}`; the OpenAI-compatible package
 * only reads `{"error": {"message"}}` and would drop the text. Rewrite the body to that shape.
 */
async function normalizeErrorBody(res: Response): Promise<Response> {
  const text = await res.text();
  let body = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") {
      body = JSON.stringify({ ...parsed, error: { message: parsed.error } });
    }
  } catch {
    // not JSON; keep it
  }
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/**
 * `fetch` for the local OpenAI-compatible servers: streamed `/chat/completions` responses go
 * through `CompatStreamFixer`, and plain-string error bodies get the OpenAI shape.
 */
export function compatFetch(base: typeof fetch): typeof fetch {
  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const res = await base(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok) return type.includes("json") ? normalizeErrorBody(res) : res;
    if (
      res.body === null ||
      !type.includes("text/event-stream") ||
      !new URL(url).pathname.endsWith("/chat/completions")
    ) {
      return res;
    }
    const fixer = new CompatStreamFixer();
    return new Response(
      rewriteSse(res.body, (d) => fixer.fixChunk(d)),
      { status: res.status, statusText: res.statusText, headers: res.headers },
    );
  };
  return wrapped as typeof fetch;
}
