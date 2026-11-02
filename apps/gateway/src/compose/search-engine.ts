import { getSetting, type PsycheDb } from "@psyche/db";
import {
  APPLE_ON_DEVICE_REF,
  type ModelProvider,
  SEARCH_MODEL_ENGINE_KEY,
  type SearchModelEngine,
} from "@psyche/protocol";

/**
 * Which model does the search jobs that read your text: reading a question, context cards,
 * rerank (docs/design/search-roadmap-2026.md, "Apple on-device model"). Setting
 * `search.model.engine`: `utility` (default) is the utility role's model; `apple` is Apple's
 * on-device model, which keeps the text on the Mac.
 *
 * `apple` fails closed: when the on-device model cannot answer (no helper, Apple Intelligence off,
 * input too long) the call ends with an error and the caller falls back to its non-model path
 * (rules for a question, no card, the plain ranking). It never retries on the utility model.
 */

/** Rerank under the 4,096-token window: eight hits of at most 512 characters each. */
export const APPLE_RERANK_TOP_N = 8;

export function searchEngine(db: PsycheDb): () => SearchModelEngine {
  return () => (getSetting(db, SEARCH_MODEL_ENGINE_KEY)?.value === "apple" ? "apple" : "utility");
}

/** The router seen by search jobs: the same provider, with the model swapped when the engine says so. */
export function searchModelProvider(
  base: ModelProvider,
  engine: () => SearchModelEngine,
): ModelProvider {
  return {
    id: base.id,
    stream: (request, options) =>
      engine() === "apple"
        ? base.stream(
            { ...request, model: APPLE_ON_DEVICE_REF, tools: [], toolChoice: "none" },
            options,
          )
        : base.stream(request, options),
    capabilities: (model) => base.capabilities(engine() === "apple" ? APPLE_ON_DEVICE_REF : model),
    ...(base.embed === undefined ? {} : { embed: base.embed.bind(base) }),
  };
}
