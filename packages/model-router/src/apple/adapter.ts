import {
  APPLE_LLM_CONTEXT_TOKENS,
  APPLE_LLM_MAX_INPUT_CHARS,
  APPLE_LLM_MAX_OUTPUT_TOKENS,
  type AppleLlmAvailability,
  type AppleLlmGenerateParams,
  type AppleLlmGenerateResult,
  type AppleLlmRefusal,
  EMPTY_USAGE,
  type JsonObject,
  type ModelCapabilities,
  type ModelEvent,
  type ModelProvider,
  type ModelRef,
  type ModelRequest,
  type NodeClient,
} from "@psyche/protocol";
import type { AdapterCallOptions } from "../adapter.ts";
import type { ProviderConfig } from "../config.ts";
import { ModelCallError, type ModelErrorKind } from "../errors.ts";

/**
 * `ModelProvider` over Apple's on-device language model, served by the Mac helper
 * (`llm.apple.generate`; docs/design/search-roadmap-2026.md, "Apple on-device model"). Ref:
 * `apple/on-device`. Local and private by construction: the prompt goes to the helper on the same
 * Mac, which runs the system model; nothing leaves the Mac and no key exists.
 *
 * What it is not: an agent model. It takes one prompt and returns text (or JSON for a schema in
 * `providerOptions.apple.schema`), has a 4,096-token window, and offers no tools, so the router
 * should never pick it as the primary. It is for small jobs over private text: reading a search
 * question, context cards, listwise rerank, memory extraction for one source. Every failure is a
 * normal `finish{error}` the router and callers already handle (unavailable, too long, guardrail).
 */

export type AppleHelper = () => Pick<NodeClient, "invoke"> | undefined;

export interface AppleAdapterDeps {
  /** The live Mac helper that offers `llm.apple.*`, or undefined. */
  node: AppleHelper;
  /** A helper call is given this long (default 70 s; the helper times the model out at 60 s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 70_000;

/** Which router error a helper refusal becomes. */
const REFUSAL_KIND: Record<AppleLlmRefusal, ModelErrorKind> = {
  unavailable: "model_not_found",
  too_long: "context_overflow",
  context_exceeded: "context_overflow",
  guardrail: "content_filter",
  unsupported_language: "bad_request",
  unsupported_schema: "bad_request",
  rate_limited: "rate_limited",
  timed_out: "timeout",
  failed: "unknown",
};

const REFUSAL_TEXT: Record<AppleLlmRefusal, string> = {
  unavailable: "Apple's on-device model is not available on this Mac",
  too_long: `the input is longer than the on-device model takes (${APPLE_LLM_MAX_INPUT_CHARS} characters)`,
  context_exceeded: "the on-device model's context window is full",
  guardrail: "the on-device model declined the request (Apple's safety guardrails)",
  unsupported_language: "the on-device model does not support this language",
  unsupported_schema: "the on-device model cannot produce that JSON shape",
  rate_limited: "the on-device model is busy",
  timed_out: "the on-device model took too long",
  failed: "the on-device model failed",
};

const REASON_TEXT: Record<string, string> = {
  unsupported_os: "it needs macOS 26 or later",
  device_not_eligible: "this Mac does not support Apple Intelligence",
  apple_intelligence_not_enabled: "Apple Intelligence is turned off in System Settings",
  model_not_ready: "the model is still downloading",
};

/** The text of one request: the system prompt, then the turns (a lone user turn goes bare). */
export function applyPrompt(request: ModelRequest): { prompt: string; instructions?: string } {
  const turns = request.messages.flatMap((m) => {
    const text = m.parts
      .flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join("\n")
      .trim();
    return text === "" || m.role === "tool" ? [] : [{ role: m.role, text }];
  });
  const prompt =
    turns.length === 1 && turns[0]?.role === "user"
      ? (turns[0]?.text ?? "")
      : turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n\n");
  const instructions = request.system?.trim();
  return instructions === undefined || instructions === "" ? { prompt } : { prompt, instructions };
}

export class AppleOnDeviceAdapter implements ModelProvider {
  readonly id: string;
  readonly config: ProviderConfig;
  readonly #deps: AppleAdapterDeps;

  constructor(config: ProviderConfig, deps: AppleAdapterDeps) {
    this.id = config.id;
    this.config = config;
    this.#deps = deps;
  }

  async capabilities(_model?: ModelRef): Promise<ModelCapabilities> {
    return {
      toolCalling: false,
      vision: false,
      reasoning: false,
      embeddings: false,
      contextWindow: APPLE_LLM_CONTEXT_TOKENS,
      maxOutputTokens: APPLE_LLM_MAX_OUTPUT_TOKENS,
    };
  }

  /** Asks the helper whether the model can run now; never runs it. `undefined`: no helper is live. */
  async availability(signal?: AbortSignal): Promise<AppleLlmAvailability | undefined> {
    const client = this.#deps.node();
    if (client === undefined) return undefined;
    const res = await client.invoke(
      "llm.apple.availability",
      {},
      { timeoutMs: 10_000, ...(signal === undefined ? {} : { signal }) },
    );
    return res.ok ? (res.result as AppleLlmAvailability) : undefined;
  }

  async *stream(request: ModelRequest, options?: AdapterCallOptions): AsyncIterable<ModelEvent> {
    const fail = (e: ModelCallError): ModelEvent => ({
      type: "finish",
      reason: "error",
      error: e.toFinishError(),
    });
    const aborted = () => options?.signal?.aborted === true;
    if (aborted()) {
      yield { type: "finish", reason: "cancelled" };
      return;
    }
    const client = this.#deps.node();
    if (client === undefined) {
      yield fail(
        new ModelCallError(
          "model_not_found",
          "Apple's on-device model needs the Mac helper, which is not connected",
        ),
      );
      return;
    }
    const { prompt, instructions } = applyPrompt(request);
    const schema = (request.providerOptions?.apple as JsonObject | undefined)?.schema;
    const params: AppleLlmGenerateParams = {
      prompt,
      ...(instructions === undefined ? {} : { instructions }),
      ...(schema === undefined || typeof schema !== "object" || schema === null
        ? {}
        : { schema: schema as Record<string, unknown> }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : {
            maxTokens: Math.min(Math.max(request.maxOutputTokens, 16), APPLE_LLM_MAX_OUTPUT_TOKENS),
          }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    };
    if (prompt === "") {
      yield fail(new ModelCallError("bad_request", "nothing to send to the on-device model"));
      return;
    }
    let result: AppleLlmGenerateResult;
    try {
      const res = await client.invoke("llm.apple.generate", params, {
        timeoutMs: this.#deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!res.ok) {
        const cancelled = res.error?.code === "cancelled" || aborted();
        if (cancelled) {
          yield { type: "finish", reason: "cancelled" };
          return;
        }
        yield fail(
          new ModelCallError(
            res.error?.code === "not_found" ? "model_not_found" : "server_error",
            res.error?.message ?? "the Mac helper could not run the on-device model",
          ),
        );
        return;
      }
      result = res.result as AppleLlmGenerateResult;
    } catch (e) {
      if (aborted()) {
        yield { type: "finish", reason: "cancelled" };
        return;
      }
      yield fail(new ModelCallError("network", e instanceof Error ? e.message : String(e)));
      return;
    }
    if (result.refusal !== undefined) {
      const why = result.reason === undefined ? undefined : REASON_TEXT[result.reason];
      yield fail(
        new ModelCallError(
          REFUSAL_KIND[result.refusal],
          `${REFUSAL_TEXT[result.refusal]}${why === undefined ? "" : `: ${why}`}`,
        ),
      );
      return;
    }
    if (result.text !== "") yield { type: "text_delta", text: result.text };
    yield {
      type: "usage",
      usage: {
        ...EMPTY_USAGE,
        // The helper does not report tokens; this is the usual four characters a token.
        input: Math.ceil((prompt.length + (instructions?.length ?? 0)) / 4),
        output: Math.ceil(result.text.length / 4),
      },
    };
    yield { type: "finish", reason: "stop" };
  }
}
