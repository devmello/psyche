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
import type { JsonObject, ModelMessage, ModelPart, ModelRequest, ToolSpec } from "@psyche/protocol";
import { type ProviderConfig, packageKey } from "./config.ts";
import { isEnvelope, type OpaqueEnvelope, type ProviderMetadata } from "./envelope.ts";

type AssistantContent = Extract<LanguageModelV4Message, { role: "assistant" }>["content"];
type UserContent = Extract<LanguageModelV4Message, { role: "user" }>["content"];
type ToolContent = Extract<LanguageModelV4Message, { role: "tool" }>["content"];
type ToolResultPart = Extract<ToolContent[number], { type: "tool-result" }>;

export interface ConvertContext {
  config: ProviderConfig;
  modelId: string;
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
  if (config.kind === "google") return { store: false };
  return {};
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

function convertToolResultOutput(part: Extract<ModelPart, { type: "tool_result" }>): LanguageModelV4ToolResultOutput {
  const { output } = part;
  if (part.isError === true) {
    return typeof output === "string" ? { type: "error-text", value: output } : { type: "error-json", value: toJsonValue(output) };
  }
  if (typeof output === "string") return { type: "text", value: output };
  // A list of text / image parts (screenshots from computer use, rendered pages).
  if (Array.isArray(output) && output.length > 0 && output.every((p) => isRecord(p) && (p.type === "text" || p.type === "image"))) {
    const value: Extract<LanguageModelV4ToolResultOutput, { type: "content" }>["value"] = [];
    for (const p of output as Record<string, unknown>[]) {
      if (p.type === "text" && typeof p.text === "string") value.push({ type: "text", text: p.text });
      else if (p.type === "image" && typeof p.mime === "string") {
        if (typeof p.data === "string") value.push({ type: "file", mediaType: p.mime, data: { type: "data", data: p.data } });
        else if (typeof p.url === "string") value.push({ type: "file", mediaType: p.mime, data: { type: "url", url: new URL(p.url) } });
      }
    }
    return { type: "content", value };
  }
  return { type: "json", value: toJsonValue(output) };
}

function imagePart(part: Extract<ModelPart, { type: "image" }>): UserContent[number] | undefined {
  if (part.data !== undefined) return { type: "file", mediaType: part.mime, data: { type: "data", data: part.data } };
  if (part.url !== undefined) return { type: "file", mediaType: part.mime, data: { type: "url", url: new URL(part.url) } };
  return undefined;
}

/** True when an envelope was produced by this provider and model (else it is dropped). */
function ownEnvelope(part: Extract<ModelPart, { type: "reasoning" }>, ctx: ConvertContext): OpaqueEnvelope | undefined {
  if (part.provider !== ctx.config.id || !isEnvelope(part.data)) return undefined;
  return part.data.model === ctx.modelId ? part.data : undefined;
}

/** Convert the normalized transcript to the AI SDK v4 prompt. */
export function convertMessages(request: ModelRequest, ctx: ConvertContext): LanguageModelV4Prompt {
  const prompt: LanguageModelV4Prompt = [];
  if (request.system !== undefined && request.system.length > 0) {
    prompt.push({ role: "system", content: request.system });
  }

  const toolNames = new Map<string, string>();
  for (const m of request.messages) {
    for (const p of m.parts) if (p.type === "tool_call") toolNames.set(p.id, p.name);
  }
  const toolResult = (p: Extract<ModelPart, { type: "tool_result" }>): ToolResultPart => ({
    type: "tool-result",
    toolCallId: p.callId,
    toolName: p.name ?? toolNames.get(p.callId) ?? "unknown_tool",
    output: convertToolResultOutput(p),
  });

  for (const message of request.messages) {
    prompt.push(...convertMessage(message, ctx, toolResult));
  }
  return prompt;
}

function convertMessage(
  message: ModelMessage,
  ctx: ConvertContext,
  toolResult: (p: Extract<ModelPart, { type: "tool_result" }>) => ToolResultPart,
): LanguageModelV4Message[] {
  const out: LanguageModelV4Message[] = [];
  if (message.role === "assistant") {
    const content: AssistantContent = [];
    // Tool-call metadata (Gemini signatures) is looked up by call id, wherever it sits.
    const callMeta = new Map<string, ProviderMetadata>();
    for (const p of message.parts) {
      if (p.type !== "reasoning") continue;
      const env = ownEnvelope(p, ctx);
      if (env?.kind === "part-metadata" && env.part === "tool_call" && env.toolCallId !== undefined) {
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
            toolName: p.name,
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
            const part: Extract<AssistantContent[number], { type: "reasoning" }> = { type: "reasoning", text: env.text };
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
                output: env.isError === true ? { type: "error-json", value: toJsonValue(env.result) } : { type: "json", value: toJsonValue(env.result) },
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

/** Mark the system prompt and the last message as Anthropic cache breakpoints. */
function applyPromptCaching(prompt: LanguageModelV4Prompt, ttl: "5m" | "1h" | undefined): void {
  const cacheControl = ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  const mark = (m: LanguageModelV4Message | undefined) => {
    if (m === undefined) return;
    m.providerOptions = { ...m.providerOptions, anthropic: { ...m.providerOptions?.anthropic, cacheControl } };
  };
  mark(prompt.find((m) => m.role === "system"));
  const last = prompt.at(-1);
  if (last !== undefined && last.role !== "system") mark(last);
}

function convertTools(
  tools: ToolSpec[] | undefined,
  ctx: ConvertContext,
): Array<LanguageModelV4FunctionTool | LanguageModelV4ProviderTool> | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  const pt = ctx.config.kind === "anthropic" ? ctx.config.providerTools : undefined;
  return tools.map((t): LanguageModelV4FunctionTool | LanguageModelV4ProviderTool => {
    if (pt?.memory === true && t.name === "memory") {
      return { type: "provider", id: "anthropic.memory_20250818", name: "memory", args: {} };
    }
    if (pt?.computer === true && t.name === "computer") {
      return { type: "provider", id: "anthropic.computer_toolset_20260801", name: "computer", args: {} };
    }
    return {
      type: "function",
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as LanguageModelV4FunctionTool["inputSchema"],
    };
  });
}

function convertToolChoice(choice: ModelRequest["toolChoice"]): LanguageModelV4ToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (typeof choice === "string") return { type: choice };
  return { type: "tool", toolName: choice.tool };
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
export function providerOptionsFor(request: ModelRequest, ctx: ConvertContext): SharedV4ProviderOptions {
  const key = packageKey(ctx.config);
  let merged = deepMerge(defaultOptions(ctx), ctx.config.defaultOptions ?? {});
  const fromKey = request.providerOptions?.[key];
  if (fromKey !== undefined) merged = deepMerge(merged, fromKey);
  const fromId = ctx.config.id !== key ? request.providerOptions?.[ctx.config.id] : undefined;
  if (fromId !== undefined) merged = deepMerge(merged, fromId);
  return Object.keys(merged).length === 0 ? {} : ({ [key]: structuredClone(merged) } as SharedV4ProviderOptions);
}

export function convertRequest(
  request: ModelRequest,
  ctx: ConvertContext,
): Omit<LanguageModelV4CallOptions, "abortSignal"> {
  const prompt = convertMessages(request, ctx);
  if (ctx.config.kind === "anthropic" && ctx.config.promptCaching !== false) {
    applyPromptCaching(prompt, ctx.config.cacheTtl);
  }
  const options: Omit<LanguageModelV4CallOptions, "abortSignal"> = { prompt };
  const tools = convertTools(request.tools, ctx);
  if (tools !== undefined) options.tools = tools;
  const toolChoice = convertToolChoice(request.toolChoice);
  if (toolChoice !== undefined && tools !== undefined) options.toolChoice = toolChoice;
  if (request.maxOutputTokens !== undefined) options.maxOutputTokens = request.maxOutputTokens;
  if (request.temperature !== undefined) options.temperature = request.temperature;
  const po = providerOptionsFor(request, ctx);
  if (Object.keys(po).length > 0) options.providerOptions = po;
  return options;
}
