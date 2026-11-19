import type {
  JSONValue,
  LanguageModelV4CallOptions,
  LanguageModelV4FunctionTool,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4ProviderTool,
  LanguageModelV4ToolChoice,
  LanguageModelV4ToolResultOutput,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import type { JsonObject, ModelMessage, ModelPart, ModelRequest } from "@psyche/protocol";
import { normalizeToolSchema, toolSchemaProblem } from "./compat.ts";
import { type ProviderConfig, packageKey } from "./config.ts";
import { isEnvelope, type OpaqueEnvelope, type ProviderMetadata } from "./envelope.ts";
import {
  cacheTtls,
  systemBlocks,
  type ToolPlan,
  toolPlan,
  toolReferences,
} from "./prompt-cache.ts";
import { THINKING_BINDING_BETA, thinkingOn, thinkingPrefix } from "./thinking.ts";
import { ToolNameMap, toolNameRuleFor } from "./tool-names.ts";

type AssistantContent = Extract<LanguageModelV4Message, { role: "assistant" }>["content"];
type UserContent = Extract<LanguageModelV4Message, { role: "user" }>["content"];
type ToolContent = Extract<LanguageModelV4Message, { role: "tool" }>["content"];
type ToolResultPart = Extract<ToolContent[number], { type: "tool-result" }>;

export interface ConvertContext {
  config: ProviderConfig;
  modelId: string;
  /** Provider-safe tool names for this request (see `tool-names.ts`); built when absent. */
  toolNames?: ToolNameMap;
  /** Anthropic thinking replay rules for this request (see `thinking.ts`); set by `convertRequest`. */
  thinking?: ThinkingReplay;
  /** Which tools go up front and which deferred (see `prompt-cache.ts`); built when absent. */
  tools?: ToolPlan;
}

interface ThinkingReplay {
  /** Thinking is on for this call; with it off, earlier thinking blocks are not sent. */
  on: boolean;
  /** The current prefix fingerprint. */
  prefix: string;
  /** Messages from this index on are the tool loop in flight (after the last user message). */
  liveFrom: number;
  /** Thinking blocks actually replayed (counted while converting). */
  replayed: number;
}

/** Claude models with adaptive thinking (4.6 and later; "always on" from the 5.5 generation). */
const ADAPTIVE_THINKING = /^claude-(?:(?:opus|sonnet)-4-[6-9]|(?:opus|sonnet|haiku|fable)-[5-9])/;

/** Default per-kind provider options, under the request's own. */
function defaultOptions(ctx: ConvertContext): JsonObject {
  const { config, modelId } = ctx;
  if (config.kind === "anthropic" && ADAPTIVE_THINKING.test(modelId)) {
    return { thinking: { type: "adaptive" } };
  }
  // Privacy default (security §2): nothing stored provider-side; encrypted reasoning comes back.
  if (config.kind === "openai") return { store: false };
  if (config.kind === "google" && config.googleApi !== "generate-content") return { store: false };
  return {};
}

/**
 * What `reasoning: "off"` sends for a model that thinks by default. Sonnet 5.5 rejects
 * `disabled` (it takes `between_tools`); Opus 5.5 and Fable cannot switch thinking off at all
 * (`undefined`: their depth is `effort`'s job); the other adaptive models accept `disabled`.
 */
export function thinkingOffFor(modelId: string): JsonObject | undefined {
  if (/^claude-sonnet-5-5/.test(modelId)) return { type: "between_tools" };
  if (/^claude-(?:opus-5-5|fable-|mythos-)/.test(modelId)) return undefined;
  return { type: "disabled" };
}

/** The request's per-route settings (`effort`, `reasoning`) as Anthropic options. */
function routeOptions(request: ModelRequest, ctx: ConvertContext): JsonObject {
  if (ctx.config.kind !== "anthropic" || !ADAPTIVE_THINKING.test(ctx.modelId)) return {};
  const out: JsonObject = {};
  if (request.effort !== undefined) out.effort = request.effort;
  if (request.reasoning === "off") {
    const off = thinkingOffFor(ctx.modelId);
    if (off !== undefined) out.thinking = off;
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toJsonValue(v: unknown): JSONValue {
  if (v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v)) as JSONValue;
  } catch {
    return String(v);
  }
}

/** Envelope metadata, re-keyed as provider options for the outgoing part. */
function optionsOf(metadata: ProviderMetadata | undefined): SharedV4ProviderOptions | undefined {
  if (metadata === undefined || Object.keys(metadata).length === 0) return undefined;
  return structuredClone(metadata) as SharedV4ProviderOptions;
}

/**
 * Provider kinds whose AI SDK adapter turns a multi-part tool result into one JSON string
 * (`@ai-sdk/openai-compatible` 3.0.77 without `supportsMultiPartToolContent`, which llama.cpp and
 * LM Studio also run on, and `ollama-ai-provider-v2` 4.1.0): an image there would reach the model
 * as megabytes of base64 text. Their tool-result images become a note. Anthropic (and
 * anthropic-compatible), OpenAI Responses, Google (both APIs) and OpenRouter carry them as images.
 * Decided here, at convert time, so a thread that switches models after storing images is covered.
 */
const TEXT_ONLY_TOOL_RESULTS: ReadonlySet<string> = new Set([
  "openai-compatible",
  "llamacpp",
  "lmstudio",
  "ollama",
]);

/** True when `kind`'s adapter sends an image inside a tool result as an image. */
export function toolResultImagesSupported(kind: string): boolean {
  return !TEXT_ONLY_TOOL_RESULTS.has(kind);
}

const TOOL_IMAGE_NOT_SENT =
  "[image not shown: this provider cannot take images inside tool results]";
const TOOL_IMAGE_LINK = "[image omitted: a tool result cannot send an image link]";

function convertToolResultOutput(
  part: Extract<ModelPart, { type: "tool_result" }>,
  ctx: ConvertContext,
): LanguageModelV4ToolResultOutput {
  const { output } = part;
  if (part.isError === true) {
    // Error results go out as JSON text: a picture in one would be base64 text.
    const safe = Array.isArray(output)
      ? output.map((p) =>
          isRecord(p) && p.type === "image" ? { type: "text", text: "[image omitted]" } : p,
        )
      : output;
    return typeof safe === "string"
      ? { type: "error-text", value: safe }
      : { type: "error-json", value: toJsonValue(safe) };
  }
  if (typeof output === "string") return { type: "text", value: output };
  // A list of text / image parts (screenshots from computer use, rendered pages).
  if (
    Array.isArray(output) &&
    output.length > 0 &&
    output.every((p) => isRecord(p) && (p.type === "text" || p.type === "image"))
  ) {
    const images = toolResultImagesSupported(ctx.config.kind);
    const value: Extract<LanguageModelV4ToolResultOutput, { type: "content" }>["value"] = [];
    for (const p of output as Record<string, unknown>[]) {
      if (p.type === "text" && typeof p.text === "string")
        value.push({ type: "text", text: p.text });
      else if (p.type === "image") {
        const mime = typeof p.mime === "string" ? p.mime : p.mimeType;
        // A tool never has the provider fetch (or pass along) a URL.
        if (typeof p.data !== "string") {
          if (typeof p.url === "string") value.push({ type: "text", text: TOOL_IMAGE_LINK });
        } else if (typeof mime !== "string") continue;
        else if (!images) value.push({ type: "text", text: TOOL_IMAGE_NOT_SENT });
        else value.push({ type: "file", mediaType: mime, data: { type: "data", data: p.data } });
      }
    }
    return { type: "content", value };
  }
  return { type: "json", value: toJsonValue(output) };
}

function imagePart(part: Extract<ModelPart, { type: "image" }>): UserContent[number] | undefined {
  if (part.data !== undefined)
    return { type: "file", mediaType: part.mime, data: { type: "data", data: part.data } };
  if (part.url !== undefined)
    return { type: "file", mediaType: part.mime, data: { type: "url", url: new URL(part.url) } };
  return undefined;
}

/** True when an envelope was produced by this provider and model (else it is dropped). */
function ownEnvelope(
  part: Extract<ModelPart, { type: "reasoning" }>,
  ctx: ConvertContext,
): OpaqueEnvelope | undefined {
  if (part.provider !== ctx.config.id || !isEnvelope(part.data)) return undefined;
  return part.data.model === ctx.modelId ? part.data : undefined;
}

/** Convert the normalized transcript to the AI SDK v4 prompt. */
export function convertMessages(request: ModelRequest, ctx: ConvertContext): LanguageModelV4Prompt {
  const prompt: LanguageModelV4Prompt = [];
  // Anthropic: the stable head and the volatile tail as two system blocks (prompt-cache.ts).
  for (const text of systemBlocks(request, ctx.config))
    prompt.push({ role: "system", content: text });

  const names = ctx.toolNames ?? ToolNameMap.for(request, toolNameRuleFor(ctx.config.kind));
  const plan = ctx.tools ?? toolPlan(request, ctx.config, ctx.modelId);
  const c: ConvertContext = { ...ctx, toolNames: names, tools: plan };
  const toolNames = new Map<string, string>();
  for (const m of request.messages) {
    for (const p of m.parts) if (p.type === "tool_call") toolNames.set(p.id, p.name);
  }
  const toolResult = (p: Extract<ModelPart, { type: "tool_result" }>): ToolResultPart => {
    const name = p.name ?? toolNames.get(p.callId) ?? "unknown_tool";
    return {
      type: "tool-result",
      toolCallId: p.callId,
      toolName: names.toProvider(name),
      output: withToolReferences(
        convertToolResultOutput(p, c),
        toolReferences(p, name, plan),
        names,
      ),
    };
  };

  for (const [index, message] of request.messages.entries()) {
    prompt.push(...convertMessage(message, c, toolResult, index));
  }
  return prompt;
}

function convertMessage(
  message: ModelMessage,
  ctx: ConvertContext,
  toolResult: (p: Extract<ModelPart, { type: "tool_result" }>) => ToolResultPart,
  index = 0,
): LanguageModelV4Message[] {
  const out: LanguageModelV4Message[] = [];
  if (message.role === "assistant") {
    const content: AssistantContent = [];
    // Tool-call metadata (Gemini signatures) is looked up by call id, wherever it sits.
    const callMeta = new Map<string, ProviderMetadata>();
    for (const p of message.parts) {
      if (p.type !== "reasoning") continue;
      const env = ownEnvelope(p, ctx);
      if (
        env?.kind === "part-metadata" &&
        env.part === "tool_call" &&
        env.toolCallId !== undefined
      ) {
        callMeta.set(env.toolCallId, env.metadata);
      }
    }
    for (const p of message.parts) {
      switch (p.type) {
        case "text":
          content.push({ type: "text", text: p.text });
          break;
        case "image": {
          const img = imagePart(p);
          if (img !== undefined) content.push(img);
          break;
        }
        case "tool_call": {
          const part: Extract<AssistantContent[number], { type: "tool-call" }> = {
            type: "tool-call",
            toolCallId: p.id,
            toolName: ctx.toolNames?.toProvider(p.name) ?? p.name,
            input: p.input ?? {},
          };
          const po = optionsOf(callMeta.get(p.id));
          if (po !== undefined) part.providerOptions = po;
          content.push(part);
          break;
        }
        case "reasoning": {
          const env = ownEnvelope(p, ctx);
          if (env === undefined) break;
          if (env.kind === "reasoning") {
            const t = ctx.thinking;
            if (t !== undefined) {
              // Thinking off: earlier blocks are not sent. A completed turn's block whose prefix
              // changed is dropped; the tool loop in flight keeps its block (the API's
              // drop_block binding covers it).
              if (!t.on) break;
              if (env.prefix !== undefined && env.prefix !== t.prefix && index < t.liveFrom) break;
              t.replayed += 1;
            }
            const part: Extract<AssistantContent[number], { type: "reasoning" }> = {
              type: "reasoning",
              text: env.text,
            };
            const po = optionsOf(env.metadata);
            if (po !== undefined) part.providerOptions = po;
            content.push(part);
          } else if (env.kind === "part-metadata" && env.part === "text") {
            const last = content.at(-1);
            const po = optionsOf(env.metadata);
            if (last?.type === "text" && po !== undefined) last.providerOptions = po;
          } else if (env.kind === "provider-tool") {
            const call: Extract<AssistantContent[number], { type: "tool-call" }> = {
              type: "tool-call",
              toolCallId: env.toolCallId,
              toolName: env.toolName,
              input: env.input ?? {},
              providerExecuted: true,
            };
            const po = optionsOf(env.metadata);
            if (po !== undefined) call.providerOptions = po;
            content.push(call);
            if (env.result !== undefined) {
              content.push({
                type: "tool-result",
                toolCallId: env.toolCallId,
                toolName: env.toolName,
                output:
                  env.isError === true
                    ? { type: "error-json", value: toJsonValue(env.result) }
                    : { type: "json", value: toJsonValue(env.result) },
              });
            }
          }
          break;
        }
        case "tool_result":
          // A result inside an assistant turn is a provider-executed tool's; keep it in place.
          content.push(toolResult(p));
          break;
      }
    }
    if (content.length > 0) out.push({ role: "assistant", content });
    return out;
  }

  // user and tool messages: tool results go in a tool message ahead of the user content.
  const results: ToolContent = [];
  const user: UserContent = [];
  for (const p of message.parts) {
    if (p.type === "tool_result") results.push(toolResult(p));
    else if (p.type === "text") user.push({ type: "text", text: p.text });
    else if (p.type === "image") {
      const img = imagePart(p);
      if (img !== undefined) user.push(img);
    }
    // tool_call and reasoning parts never belong to user / tool turns; they are dropped.
  }
  if (results.length > 0) out.push({ role: "tool", content: results });
  if (user.length > 0) out.push({ role: "user", content: user });
  return out;
}

/**
 * A `load_tools` result that loaded deferred tools also names them with `tool_reference` blocks,
 * after the same JSON text the model read before, so the API expands them into context
 * (custom tool search). Other results are unchanged.
 */
function withToolReferences(
  output: LanguageModelV4ToolResultOutput,
  refs: string[],
  names: ToolNameMap,
): LanguageModelV4ToolResultOutput {
  if (refs.length === 0 || output.type !== "json") return output;
  return {
    type: "content",
    value: [
      { type: "text", text: JSON.stringify(output.value) },
      ...refs.map((n) => ({
        type: "custom" as const,
        providerOptions: { anthropic: { type: "tool-reference", toolName: names.toProvider(n) } },
      })),
    ],
  };
}

/**
 * Anthropic cache breakpoints (prompt-cache.ts): the last tool sent up front and the first
 * system block (the stable head) with the prefix TTL, and the last message with the tail TTL.
 * At most three of the API's four, longer TTLs first.
 */
function applyPromptCaching(
  prompt: LanguageModelV4Prompt,
  tools: Array<LanguageModelV4FunctionTool | LanguageModelV4ProviderTool> | undefined,
  ttls: { prefix: "5m" | "1h"; tail: "5m" | "1h" },
): void {
  const control = (ttl: "5m" | "1h") =>
    ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  const mark = (
    target: { providerOptions?: SharedV4ProviderOptions } | undefined,
    ttl: "5m" | "1h",
  ) => {
    if (target === undefined) return;
    target.providerOptions = {
      ...target.providerOptions,
      anthropic: { ...target.providerOptions?.anthropic, cacheControl: control(ttl) },
    };
  };
  // A deferred tool cannot carry cache_control (400): the last function tool sent up front.
  const upFront = tools?.filter(
    (t): t is LanguageModelV4FunctionTool =>
      t.type === "function" && t.providerOptions?.anthropic?.deferLoading !== true,
  );
  mark(upFront?.at(-1), ttls.prefix);
  mark(
    prompt.find((m) => m.role === "system"),
    ttls.prefix,
  );
  const last = prompt.at(-1);
  if (last !== undefined && last.role !== "system") mark(last, ttls.tail);
}

function convertTools(
  plan: ToolPlan,
  ctx: ConvertContext,
): Array<LanguageModelV4FunctionTool | LanguageModelV4ProviderTool> | undefined {
  const deferred = new Set(plan.deferred.map((t) => t.name));
  const tools = [...plan.upFront, ...plan.deferred];
  if (tools.length === 0) return undefined;
  const pt = ctx.config.kind === "anthropic" ? ctx.config.providerTools : undefined;
  return tools.map((t): LanguageModelV4FunctionTool | LanguageModelV4ProviderTool => {
    if (pt?.memory === true && t.name === "memory") {
      return { type: "provider", id: "anthropic.memory_20250818", name: "memory", args: {} };
    }
    if (pt?.computer === true && t.name === "computer") {
      return {
        type: "provider",
        id: "anthropic.computer_toolset_20260801",
        name: "computer",
        args: {},
      };
    }
    // Providers need a top-level object schema (#414): unions become one object, and a tool
    // that still is not one fails this request locally, naming the tool.
    const inputSchema = normalizeToolSchema(t.inputSchema);
    const problem = toolSchemaProblem({ name: t.name, inputSchema });
    if (problem !== undefined) throw new Error(problem);
    return {
      type: "function",
      name: ctx.toolNames?.toProvider(t.name) ?? t.name,
      description: t.description,
      inputSchema: inputSchema as LanguageModelV4FunctionTool["inputSchema"],
      ...(deferred.has(t.name) ? { providerOptions: { anthropic: { deferLoading: true } } } : {}),
    };
  });
}

function convertToolChoice(
  choice: ModelRequest["toolChoice"],
  ctx: ConvertContext,
): LanguageModelV4ToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (typeof choice === "string") return { type: choice };
  return { type: "tool", toolName: ctx.toolNames?.toProvider(choice.tool) ?? choice.tool };
}

function deepMerge(base: JsonObject, over: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const prev = out[k];
    out[k] = isRecord(prev) && isRecord(v) ? deepMerge(prev as JsonObject, v as JsonObject) : v;
  }
  return out;
}

/**
 * `providerOptions` for the call: kind defaults, then the config's defaults, then the request's
 * options keyed by the adapter id or by the package key (`anthropic`, `openai`, …).
 */
export function providerOptionsFor(
  request: ModelRequest,
  ctx: ConvertContext,
): SharedV4ProviderOptions {
  const key = packageKey(ctx.config);
  let merged = deepMerge(defaultOptions(ctx), ctx.config.defaultOptions ?? {});
  // The route's own settings sit above the defaults and below an explicit providerOptions.
  merged = deepMerge(merged, routeOptions(request, ctx));
  const fromKey = request.providerOptions?.[key];
  if (fromKey !== undefined) merged = deepMerge(merged, fromKey);
  const fromId = ctx.config.id !== key ? request.providerOptions?.[ctx.config.id] : undefined;
  if (fromId !== undefined) merged = deepMerge(merged, fromId);
  return Object.keys(merged).length === 0
    ? {}
    : ({ [key]: structuredClone(merged) } as SharedV4ProviderOptions);
}

export function convertRequest(
  request: ModelRequest,
  ctx: ConvertContext,
): Omit<LanguageModelV4CallOptions, "abortSignal"> {
  const toolNames = ctx.toolNames ?? ToolNameMap.for(request, toolNameRuleFor(ctx.config.kind));
  const plan = ctx.tools ?? toolPlan(request, ctx.config, ctx.modelId);
  const po = providerOptionsFor(request, ctx);
  const key = packageKey(ctx.config);
  let thinking: ThinkingReplay | undefined;
  if (ctx.config.kind === "anthropic") {
    let lastUser = -1;
    for (const [i, m] of request.messages.entries()) if (m.role === "user") lastUser = i;
    thinking = {
      on: thinkingOn(po, key),
      prefix: thinkingPrefix(request, toolNames, plan.upFront),
      liveFrom: lastUser + 1,
      replayed: 0,
    };
  }
  const c: ConvertContext = {
    ...ctx,
    toolNames,
    tools: plan,
    ...(thinking === undefined ? {} : { thinking }),
  };
  const prompt = convertMessages(request, c);
  const options: Omit<LanguageModelV4CallOptions, "abortSignal"> = { prompt };
  const tools = convertTools(plan, c);
  if (tools !== undefined) options.tools = tools;
  if (
    ctx.config.kind === "anthropic" &&
    ctx.config.promptCaching !== false &&
    // `cache: "none"`: a one-shot call whose unique tail is never read again marks nothing.
    request.cache !== "none"
  ) {
    applyPromptCaching(prompt, tools, cacheTtls(request, ctx.config));
  }
  const toolChoice = convertToolChoice(request.toolChoice, c);
  if (toolChoice !== undefined && tools !== undefined) options.toolChoice = toolChoice;
  if (request.maxOutputTokens !== undefined) options.maxOutputTokens = request.maxOutputTokens;
  if (request.temperature !== undefined) options.temperature = request.temperature;
  if (thinking?.on && thinking.replayed > 0 && ctx.config.thinkingBlockBinding !== false) {
    const own = po[key] as { thinking?: Record<string, unknown> } | undefined;
    if (own?.thinking !== undefined && own.thinking.blockBinding === undefined) {
      own.thinking.blockBinding = { prefixMismatchBehavior: "drop_block" };
      options.headers = { "anthropic-beta": THINKING_BINDING_BETA };
    }
  }
  if (Object.keys(po).length > 0) options.providerOptions = po;
  return options;
}
