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

// --- Tool input schemas (#414) -----------------------------------------------------------------

/**
 * Every provider the router speaks to (Anthropic `input_schema`, OpenAI / OpenRouter /
 * OpenAI-compatible `parameters`, Gemini function declarations, Ollama) wants a tool's input
 * schema to be one object: `{"type": "object", …}`. A tool whose schema is a top-level union
 * (TypeBox `Type.Union`, so `{"anyOf": [...]}`) makes the provider refuse the whole request.
 *
 * `normalizeToolSchema` turns a top-level `anyOf` / `oneOf` / `allOf` of object variants into
 * one object: every variant's properties (a property the variants disagree on becomes an `enum`
 * of their constants or an `anyOf` of their schemas), `required` = what every variant requires
 * (`allOf`: what any requires). The variants stay model-visible as a summary in `description`.
 * The executor still validates the real union. `toolSchemaProblem` names what is still wrong.
 */

type Schema = Record<string, unknown>;

function isSchema(v: unknown): v is Schema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isSchema(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function asObject(schema: unknown): Schema | undefined {
  if (!isSchema(schema)) return undefined;
  if (schema.type === "object") return schema;
  if (schema.type === undefined && isSchema(schema.properties))
    return { ...schema, type: "object" };
  const nested = normalizeToolSchema(schema);
  return isSchema(nested) && nested.type === "object" ? nested : undefined;
}

/** Merge one property's schemas from several variants. */
function mergeProperty(schemas: Schema[]): Schema {
  const distinct = [...new Map(schemas.map((s) => [stableJson(s), s])).values()];
  if (distinct.length === 1) return distinct[0] as Schema;
  const consts = distinct.flatMap((s) =>
    typeof s.const === "string"
      ? [s.const]
      : Array.isArray(s.enum) && s.enum.every((e) => typeof e === "string")
        ? (s.enum as string[])
        : [null],
  );
  if (consts.every((c): c is string => c !== null)) {
    const first = distinct[0] as Schema;
    const out: Schema = { type: "string", enum: [...new Set(consts)] };
    if (typeof first.description === "string") out.description = first.description;
    return out;
  }
  return { anyOf: distinct };
}

function shapeOf(variant: Schema): string {
  const props = isSchema(variant.properties) ? variant.properties : {};
  const required = new Set(Array.isArray(variant.required) ? (variant.required as string[]) : []);
  const fields = Object.entries(props).map(([name, p]) => {
    if (isSchema(p) && p.const !== undefined) return `${name}: ${JSON.stringify(p.const)}`;
    return required.has(name) ? name : `${name}?`;
  });
  return `{${fields.join(", ")}}`;
}

const SUMMARY_MAX = 1200;

export function normalizeToolSchema(schema: unknown): unknown {
  if (!isSchema(schema) || schema.type === "object") return schema;
  if (schema.type === undefined && isSchema(schema.properties))
    return { ...schema, type: "object" };
  const key = Array.isArray(schema.anyOf)
    ? "anyOf"
    : Array.isArray(schema.oneOf)
      ? "oneOf"
      : Array.isArray(schema.allOf)
        ? "allOf"
        : undefined;
  if (key === undefined || schema.type !== undefined) return schema;
  const variants = (schema[key] as unknown[]).map(asObject);
  if (variants.length === 0 || variants.some((v) => v === undefined)) return schema;
  const objects = variants as Schema[];

  const byName = new Map<string, Schema[]>();
  for (const v of objects) {
    for (const [name, p] of Object.entries(isSchema(v.properties) ? v.properties : {})) {
      if (!isSchema(p)) continue;
      byName.set(name, [...(byName.get(name) ?? []), p]);
    }
  }
  const properties: Schema = {};
  for (const [name, list] of byName) properties[name] = mergeProperty(list);

  const requiredOf = (v: Schema) =>
    new Set(
      Array.isArray(v.required)
        ? (v.required as unknown[]).filter((r) => typeof r === "string")
        : [],
    );
  let required: string[];
  if (key === "allOf") {
    required = [...new Set(objects.flatMap((v) => [...requiredOf(v)]))] as string[];
  } else {
    const [first, ...rest] = objects.map(requiredOf);
    required = [...(first ?? new Set())].filter((r) => rest.every((s) => s.has(r))) as string[];
  }

  const { anyOf: _a, oneOf: _o, allOf: _l, ...base } = schema;
  const out: Schema = { ...base, type: "object", properties };
  if (required.length > 0) out.required = required;
  if (objects.every((v) => v.additionalProperties === false)) out.additionalProperties = false;
  if (key !== "allOf" && objects.length > 1) {
    let summary = `Accepts exactly one of these shapes (leave out fields a shape does not list): ${objects.map(shapeOf).join("; ")}.`;
    if (summary.length > SUMMARY_MAX) summary = `${summary.slice(0, SUMMARY_MAX - 1)}…`;
    out.description =
      typeof base.description === "string" && base.description.length > 0
        ? `${base.description} ${summary}`
        : summary;
  }
  return out;
}

/**
 * Why a tool's (normalized) input schema cannot go to a provider, naming the tool; undefined
 * when it is a top-level object. The adapter refuses the request with this as a `bad_request`
 * before anything is sent.
 */
export function toolSchemaProblem(spec: {
  name: string;
  inputSchema: unknown;
}): string | undefined {
  const s = spec.inputSchema;
  if (!isSchema(s)) return `tool "${spec.name}" has no JSON Schema object as its input schema`;
  if (s.type === "object") return undefined;
  const top =
    s.type !== undefined
      ? `"type": ${JSON.stringify(s.type)}`
      : (["anyOf", "oneOf", "allOf", "not", "$ref"].find((k) => k in s) ?? 'no "type"');
  return `tool "${spec.name}" input schema must be {"type": "object", …} at the top level (it has ${top}); providers refuse the whole request otherwise`;
}
