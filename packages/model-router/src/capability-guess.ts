import type { ModelCapabilities } from "@psyche/protocol";
import type { PriceEntry } from "./prices.ts";

/**
 * Capability guesses for models an endpoint lists (B4). An absent flag means unknown, not
 * false. Facts merge by authority: a name heuristic, then the vendored catalog (price table),
 * then what the server's own listing says, then the owner's provider config.
 */

export type FactSource = "listing" | "catalog" | "config" | "heuristic";

export interface CapabilityFacts {
  toolCalling?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  embeddings?: boolean;
  contextWindow?: number;
}

export interface CapabilityGuess extends CapabilityFacts {
  source: FactSource;
}

const EMBEDDING = /embed|(?:^|[/_-])(?:bge|e5|gte)[-_]|minilm|nomic-bert/i;
const VISION =
  /vision|[-_.]vl(?:\b|[-_])|llava|pixtral|gemma-?[34]|minicpm-v|moondream|mllama|internvl|smolvlm|qwen[\d.]*-?omni/i;
const REASONING =
  /qwq|deepseek-r1|r1-distill|qwen3|gpt-oss|thinking|reason|magistral|glm-4\.[5-9]|phi-4-mini-reasoning/i;
const TOOLS =
  /qwen(?:2\.5|3)|llama-?3\.[1-3]|llama-?4|mistral|mixtral|devstral|gpt-oss|glm-4|hermes|functionary|command-r|granite|gemma-?4|kimi|firefunction/i;

/** What the model id alone suggests (local model names). */
export function guessFromName(modelId: string): CapabilityFacts {
  const facts: CapabilityFacts = {};
  if (EMBEDDING.test(modelId)) {
    facts.embeddings = true;
    facts.toolCalling = false;
    facts.vision = false;
    return facts;
  }
  if (VISION.test(modelId)) facts.vision = true;
  if (REASONING.test(modelId)) facts.reasoning = true;
  if (TOOLS.test(modelId)) facts.toolCalling = true;
  return facts;
}

export function factsFromPrice(price: PriceEntry): CapabilityFacts {
  const facts: CapabilityFacts = { embeddings: price.mode === "embedding" };
  if (price.toolCalling !== undefined) facts.toolCalling = price.toolCalling;
  if (price.vision !== undefined) facts.vision = price.vision;
  if (price.reasoning !== undefined) facts.reasoning = price.reasoning;
  if (price.contextWindow !== undefined) facts.contextWindow = price.contextWindow;
  return facts;
}

export function factsFromConfig(caps: Partial<ModelCapabilities> | undefined): CapabilityFacts {
  const facts: CapabilityFacts = {};
  if (caps === undefined) return facts;
  if (caps.toolCalling !== undefined) facts.toolCalling = caps.toolCalling;
  if (caps.vision !== undefined) facts.vision = caps.vision;
  if (caps.reasoning !== undefined) facts.reasoning = caps.reasoning;
  if (caps.embeddings !== undefined) facts.embeddings = caps.embeddings;
  if (caps.contextWindow !== undefined) facts.contextWindow = caps.contextWindow;
  return facts;
}

const KEYS = ["toolCalling", "vision", "reasoning", "embeddings", "contextWindow"] as const;

/**
 * Merge layers lowest authority first. `source` names the most authoritative layer that
 * contributed a fact (`heuristic` when nothing is known).
 */
export function mergeFacts(
  layers: readonly (readonly [FactSource, CapabilityFacts | undefined])[],
): CapabilityGuess {
  const out: CapabilityGuess = { source: "heuristic" };
  for (const [source, facts] of layers) {
    if (facts === undefined) continue;
    let contributed = false;
    for (const k of KEYS) {
      const v = facts[k];
      if (v === undefined) continue;
      (out as unknown as Record<string, unknown>)[k] = v;
      contributed = true;
    }
    if (contributed) out.source = source;
  }
  return out;
}
