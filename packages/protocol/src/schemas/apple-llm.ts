import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "../common.ts";
import type { NodeCapability } from "./identity.ts";

/**
 * Apple's on-device language model (the `FoundationModels` framework, macOS 26 with Apple
 * Intelligence) as a local model option. The Mac helper's `llm.apple.generate` runs one prompt
 * through `SystemLanguageModel.default` and returns the text, or JSON when a schema asks for
 * guided generation. System model: no download, no key, nothing leaves the Mac, and the model's
 * memory is the system's, not ours.
 *
 * Only the Gateway's model router calls it (provider kind `apple`, ref `apple/on-device`);
 * `nodes.invoke` and agent tools cannot reach `llm.*`. The reply is model output and is as
 * untrusted as any other model's. Nothing here has been run against the real model by the tests:
 * they use fakes. See docs/design/search-roadmap-2026.md ("Apple on-device model").
 */

/** The model ref the router serves for this provider (`apple` is the provider id). */
export const APPLE_ON_DEVICE_REF = "apple/on-device";
/** The model's context window (input and output together), tokens, as Apple documents it. */
export const APPLE_LLM_CONTEXT_TOKENS = 4096;
/**
 * Prompt and instructions together may be this long, characters (about 3,000 tokens, leaving the
 * rest of the window for the answer). Longer input is refused with `too_long`, never cut.
 */
export const APPLE_LLM_MAX_INPUT_CHARS = 9000;
export const APPLE_LLM_MAX_OUTPUT_TOKENS = 1024;
export const APPLE_LLM_DEFAULT_OUTPUT_TOKENS = 512;
export const APPLE_LLM_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Setting `search.model.engine`: which model does the search jobs that read your text (reading a
 * question, context cards, rerank). `utility` (default) is the utility role's model; `apple` is
 * the on-device model, and when it is unavailable those jobs do nothing (rules and plain ranking
 * stand) instead of falling back to a cloud model.
 */
export const SEARCH_MODEL_ENGINE_KEY = "search.model.engine";
export const SEARCH_MODEL_ENGINES = ["utility", "apple"] as const;
export type SearchModelEngine = (typeof SEARCH_MODEL_ENGINES)[number];

/** Why the model cannot run right now (mirrors `SystemLanguageModel.Availability`). */
export const AppleLlmUnavailableReason = StringEnum(
  [
    "unsupported_os",
    "device_not_eligible",
    "apple_intelligence_not_enabled",
    "model_not_ready",
    "unknown",
  ],
  { $id: "AppleLlmUnavailableReason" },
);
export type AppleLlmUnavailableReason = Static<typeof AppleLlmUnavailableReason>;

export const AppleLlmAvailability = Type.Object(
  {
    available: Type.Boolean(),
    reason: Type.Optional(AppleLlmUnavailableReason),
    contextTokens: Type.Integer({ minimum: 1, description: "Input and output together" }),
  },
  { $id: "AppleLlmAvailability" },
);
export type AppleLlmAvailability = Static<typeof AppleLlmAvailability>;

/** What Settings shows for the on-device model: `models.appleStatus`. */
export const AppleLlmStatus = Type.Object(
  {
    ref: Type.String({ description: "The model ref to select, apple/on-device" }),
    helperConnected: Type.Boolean({ description: "A Mac helper that offers llm.apple.* is live" }),
    available: Type.Boolean(),
    reason: Type.Optional(AppleLlmUnavailableReason),
    contextTokens: Type.Integer({ minimum: 1 }),
  },
  { $id: "AppleLlmStatus" },
);
export type AppleLlmStatus = Static<typeof AppleLlmStatus>;

export const AppleLlmAvailabilityParams = Type.Object({}, { $id: "AppleLlmAvailabilityParams" });
export type AppleLlmAvailabilityParams = Static<typeof AppleLlmAvailabilityParams>;

export const AppleLlmGenerateParams = Type.Object(
  {
    prompt: Type.String({ minLength: 1, maxLength: APPLE_LLM_MAX_INPUT_CHARS }),
    instructions: Type.Optional(Type.String({ maxLength: APPLE_LLM_MAX_INPUT_CHARS })),
    schema: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "Guided generation: a JSON Schema subset (object, array, string, number, integer, boolean, string enum; properties, required, items). The reply is JSON text of that shape.",
      }),
    ),
    maxTokens: Type.Optional(Type.Integer({ minimum: 16, maximum: APPLE_LLM_MAX_OUTPUT_TOKENS })),
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120_000 })),
  },
  { $id: "AppleLlmGenerateParams" },
);
export type AppleLlmGenerateParams = Static<typeof AppleLlmGenerateParams>;

/** Why no text came back. None of these throws: the router turns them into a normal model error. */
export const AppleLlmRefusal = StringEnum(
  [
    "unavailable",
    "too_long",
    "context_exceeded",
    "guardrail",
    "unsupported_language",
    "unsupported_schema",
    "rate_limited",
    "timed_out",
    "failed",
  ],
  { $id: "AppleLlmRefusal" },
);
export type AppleLlmRefusal = Static<typeof AppleLlmRefusal>;

export const AppleLlmGenerateResult = Type.Object(
  {
    text: Type.String(),
    structured: Type.Boolean({ description: "True when `text` is JSON from a schema" }),
    refusal: Type.Optional(AppleLlmRefusal),
    reason: Type.Optional(AppleLlmUnavailableReason),
  },
  { $id: "AppleLlmGenerateResult" },
);
export type AppleLlmGenerateResult = Static<typeof AppleLlmGenerateResult>;

export const APPLE_LLM_CAPABILITIES: readonly NodeCapability[] = [
  {
    name: "llm.apple.availability",
    description:
      "Whether Apple's on-device language model can run (Apple Intelligence on, device eligible, model ready); model router only",
    sideEffect: "read",
  },
  {
    name: "llm.apple.generate",
    description:
      "One prompt through Apple's on-device language model (text, or JSON with a schema); model router only",
    sideEffect: "read",
  },
];
