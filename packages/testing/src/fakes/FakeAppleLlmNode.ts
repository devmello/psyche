import {
  APPLE_LLM_CAPABILITIES,
  APPLE_LLM_CONTEXT_TOKENS,
  APPLE_LLM_MAX_INPUT_CHARS,
  type AppleLlmAvailability,
  type AppleLlmGenerateParams,
  type AppleLlmGenerateResult,
  type AppleLlmRefusal,
} from "@psyche/protocol";
import { FakeNodeClient } from "./FakeNodeClient.ts";

/**
 * A mac-helper-shaped node serving `llm.apple.*` over a script, with the helper's rules: input
 * over the cap is `too_long`, an unavailable model is a refusal with the reason, a failure is a
 * refusal. It never runs a model. `requests` lists every generate call, so tests can assert what
 * reached the on-device model and, for fail-closed paths, that nothing did.
 */
export class FakeAppleLlmNode extends FakeNodeClient {
  availability: AppleLlmAvailability = {
    available: true,
    contextTokens: APPLE_LLM_CONTEXT_TOKENS,
  };
  /** Text for the next calls, in order; the last one repeats. A function gets the params. */
  replies: (string | ((p: AppleLlmGenerateParams) => string))[] = ["ok"];
  /** Refuse every generate call with this. */
  refuse: AppleLlmRefusal | undefined;
  readonly requests: AppleLlmGenerateParams[] = [];

  constructor(options: { nodeId?: string } = {}) {
    super({ nodeId: options.nodeId ?? "node_mac_apple_llm", kind: "mac-helper" });
    for (const capability of APPLE_LLM_CAPABILITIES) {
      this.handle({
        capability: structuredClone(capability),
        handle: (p) =>
          capability.name === "llm.apple.availability"
            ? this.availability
            : this.#generate(p as AppleLlmGenerateParams),
      });
    }
  }

  #generate(p: AppleLlmGenerateParams): AppleLlmGenerateResult {
    const none = (refusal: AppleLlmRefusal, reason?: AppleLlmGenerateResult["reason"]) => ({
      text: "",
      structured: false,
      refusal,
      ...(reason === undefined ? {} : { reason }),
    });
    if (p.prompt.length + (p.instructions?.length ?? 0) > APPLE_LLM_MAX_INPUT_CHARS)
      return none("too_long");
    if (!this.availability.available) return none("unavailable", this.availability.reason);
    this.requests.push(structuredClone(p));
    if (this.refuse !== undefined) return none(this.refuse);
    const next = this.replies[Math.min(this.requests.length - 1, this.replies.length - 1)] ?? "";
    return {
      text: typeof next === "function" ? next(p) : next,
      structured: p.schema !== undefined,
    };
  }
}
