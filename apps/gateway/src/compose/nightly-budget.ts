import type { ModelCallOptions, ModelEvent, ModelProvider, ModelRequest } from "@psyche/protocol";

/**
 * One nightly token budget for the two model passes over the owner's memory (memory audit P8):
 * the everything-memory extraction pass and the people-graph model pass. The extraction pass
 * counts its own batches, then hands the tokens left to the graph pass, which must stay inside
 * them. The graph pass loop only checks its budget between entities, so a single call could cross
 * the line; this wrapper makes the limit hard instead: a call that could not fit in what is left
 * is refused before it is sent (the pass then skips that entity), and what is spent is counted
 * from the provider's own usage report (an estimate when it reports none).
 */

export interface BudgetedProvider extends ModelProvider {
  /** Tokens spent so far through this wrapper (input and output). */
  spent(): number;
}

const CHARS_PER_TOKEN = 4;
/** What a call may write when the request names no output cap. */
const DEFAULT_OUTPUT_ALLOWANCE = 800;

function requestChars(request: ModelRequest): number {
  let n = typeof request.system === "string" ? request.system.length : 0;
  for (const m of request.messages) {
    for (const part of m.parts) if (part.type === "text") n += part.text.length;
  }
  return n;
}

export function budgetedProvider(inner: ModelProvider, limit: number): BudgetedProvider {
  let spent = 0;
  return {
    id: inner.id,
    capabilities: (model) => inner.capabilities(model),
    ...(inner.embed === undefined ? {} : { embed: inner.embed.bind(inner) }),
    spent: () => spent,
    async *stream(request: ModelRequest, options?: ModelCallOptions): AsyncIterable<ModelEvent> {
      const input = Math.ceil(requestChars(request) / CHARS_PER_TOKEN);
      const worst = input + (request.maxOutputTokens ?? DEFAULT_OUTPUT_ALLOWANCE);
      if (spent + worst > limit) {
        // Refused, not sent: nothing is spent, and the caller sees an ordinary failed call.
        yield { type: "finish", reason: "error", error: "unknown: nightly token budget spent" };
        return;
      }
      let reported = 0;
      let replyChars = 0;
      try {
        for await (const e of inner.stream(request, options)) {
          if (e.type === "usage") reported = e.usage.input + e.usage.output;
          if (e.type === "text_delta") replyChars += e.text.length;
          yield e;
        }
      } finally {
        spent += reported > 0 ? reported : input + Math.ceil(replyChars / CHARS_PER_TOKEN);
      }
    },
  };
}
