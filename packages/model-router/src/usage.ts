import type { LanguageModelV4Usage } from "@ai-sdk/provider";
import { EMPTY_USAGE, type Usage } from "@psyche/protocol";

/**
 * Token classes are disjoint so cost is a plain dot product and nothing is billed twice:
 *
 * - `input`: prompt tokens read without the cache (AI SDK `inputTokens.noCache`)
 * - `cacheRead`, `cacheWrite`: prompt tokens read from / written to the prompt cache
 * - `output`: every generated token, reasoning included (providers bill reasoning as output)
 * - `reasoning`: the reasoning share of `output`, for display only
 *
 * So total prompt tokens are `input + cacheRead + cacheWrite`, and total generated tokens are
 * `output`. OpenAI-style dashboards that report "prompt tokens" include cached reads; compare
 * against `input + cacheRead + cacheWrite`.
 */
export function normalizeUsage(u: LanguageModelV4Usage | undefined): Usage {
  if (u === undefined) return { ...EMPTY_USAGE };
  const cacheRead = int(u.inputTokens.cacheRead);
  const cacheWrite = int(u.inputTokens.cacheWrite);
  const total = int(u.inputTokens.total);
  const derived = Math.max(0, total - cacheRead - cacheWrite);
  // Some providers (OpenRouter) report noCache = total - cacheRead, leaving cache writes in;
  // when the total is known, never let the classes add up to more than it.
  const input =
    u.inputTokens.noCache === undefined
      ? derived
      : u.inputTokens.total === undefined
        ? int(u.inputTokens.noCache)
        : Math.min(int(u.inputTokens.noCache), derived);
  const reasoning = int(u.outputTokens.reasoning);
  const outputTotal = u.outputTokens.total;
  const output =
    outputTotal !== undefined ? int(outputTotal) : int(u.outputTokens.text) + reasoning;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: Math.min(reasoning, output),
    costUsd: 0,
  };
}

function int(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    costUsd: roundUsd(a.costUsd + b.costUsd),
  };
}

/** Cost rounding: 1e-9 USD keeps sums stable without hiding sub-cent calls. */
export function roundUsd(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}
